/**
 * ═══ OPENROUTER IMAGE CLIENT — SERVER ONLY ══════════════════════════════════
 *
 * The image API is NOT chat completions. `black-forest-labs/flux.2-klein-4b`
 * is served by `POST https://openrouter.ai/api/v1/images`, which returns
 * base64-encoded bytes:
 *
 *   { created, data: [{ b64_json, media_type }], usage: { ..., cost } }
 *
 * Sending it to `/chat/completions` fails; parsing a chat-shaped response here
 * fails too. This module speaks only the image contract.
 *
 * ⚠️ `OPENROUTER_API_KEY` never leaves this module. It is not a
 * `NEXT_PUBLIC_` variable and must never be returned in a response or logged.
 * No prompt text is logged either.
 *
 * ═══ WHAT COUNTS AS A USABLE IMAGE ══════════════════════════════════════════
 *
 * A 200 is not success. The bytes have to decode, be non-empty, and start with
 * a PNG or JPEG signature — otherwise the provider returned HTML, an error
 * document, or a truncated body and the browser would get a broken image or an
 * `about:blank`. A `url`-only response is refused rather than fetched: fetching
 * a provider-supplied URL would be a new SSRF surface, and this endpoint's
 * contract is base64 bytes.
 *
 * ═══ RETRY RULES ════════════════════════════════════════════════════════════
 *
 * Image billing is all-or-nothing: OpenRouter bills a completed generation in
 * full and bills nothing for a failed one. That makes exactly one retry safe,
 * and only when the provider answered 429, 502 or 503 — the documented
 * "nothing was generated" answers. A TIMEOUT or a dropped connection is NOT
 * retried: the provider may have completed and billed the first image, and a
 * second request would be a second charge that no client-side check can undo.
 */

import type { AiImageModel } from "./image-models";
import { parseRetryAfterMs, retryWithBackoff, type RetryPolicy } from "./retry";
import type { ImageOutputFormat } from "@/lib/image-generation-options";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

const DEFAULT_TIMEOUT_MS = 120_000;

/** A generated image larger than this is refused rather than shipped to the browser. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Base64 expands by 4/3; this bounds the JSON body before decoding it. */
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;

export const DEFAULT_IMAGE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  /** A provider asking for a longer wait than this is answered with its 429 instead of blocking the route. */
  maxRetryAfterMs: 5_000,
  minRemainingMs: 1_000,
};

export type ImageGenerationErrorCode =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "TIMEOUT"
  | "NETWORK"
  | "CONTENT_FILTER"
  | "EMPTY_RESPONSE"
  | "INVALID_RESPONSE"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

export interface ImageGenerationUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** The provider's own USD price for this generation, when it reports one. */
  costUsd: number | null;
}

export interface GeneratedImage {
  /** Base64 bytes, WITHOUT a `data:` prefix. */
  base64: string;
  mediaType: "image/png" | "image/jpeg";
  format: ImageOutputFormat;
  bytes: number;
}

/** Safe provider metadata. Never contains the key, request headers or the image bytes. */
export interface ImageGenerationMetadata {
  status: number | null;
  requestedModel: string;
  providerRequestId: string | null;
  retryAfterMs: number | null;
  errorCode: ImageGenerationErrorCode | null;
  errorDetail: string | null;
}

export interface ImageGenerationSuccess {
  ok: true;
  image: GeneratedImage;
  model: string;
  usage: ImageGenerationUsage;
  metadata: ImageGenerationMetadata;
}

export interface ImageGenerationFailure {
  ok: false;
  error: string;
  status?: number;
  code: ImageGenerationErrorCode;
  retryable: boolean;
  retryAfterMs: number | null;
  metadata: ImageGenerationMetadata;
}

export type ImageGenerationResult = ImageGenerationSuccess | ImageGenerationFailure;

export interface GenerateImageInput {
  model: AiImageModel;
  prompt: string;
  aspectRatio: string;
  outputFormat: ImageOutputFormat;
  seed?: number | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests use this to skip real backoff. Production callers should not. */
  retry?: Partial<RetryPolicy>;
}

const EMPTY_USAGE: ImageGenerationUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  costUsd: null,
};

export function isImageGenerationFailure(
  result: ImageGenerationResult,
): result is ImageGenerationFailure {
  return result.ok === false;
}

/**
 * Generate ONE image. Bounded: at most two provider requests, and only the
 * second one may follow a 429/502/503.
 */
export async function generateImage(input: GenerateImageInput): Promise<ImageGenerationResult> {
  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;

  const result = await retryWithBackoff<ImageGenerationResult>(
    () => attemptImage(input, timeoutMs),
    (attempt) => ({
      retryable: attempt.ok === false && isSafeImageRetry(attempt),
      retryAfterMs: attempt.ok === false ? attempt.retryAfterMs : null,
    }),
    { policy: { ...DEFAULT_IMAGE_RETRY_POLICY, ...(input.retry ?? {}) } },
  );

  return result;
}

/**
 * A retry is safe only when the provider answered that nothing was generated.
 * A timeout, a network error, an unreadable 200 or a 500 is not retried.
 */
export function isSafeImageRetry(failure: ImageGenerationFailure): boolean {
  return failure.status === 429 || failure.status === 502 || failure.status === 503;
}

function baseMetadata(model: AiImageModel, status: number | null): ImageGenerationMetadata {
  return {
    status,
    requestedModel: model.id,
    providerRequestId: null,
    retryAfterMs: null,
    errorCode: null,
    errorDetail: null,
  };
}

function failureResult(input: {
  code: ImageGenerationErrorCode;
  retryable: boolean;
  error: string;
  status?: number;
  retryAfterMs?: number | null;
  metadata: ImageGenerationMetadata;
}): ImageGenerationFailure {
  const metadata: ImageGenerationMetadata = {
    ...input.metadata,
    status: input.status ?? input.metadata.status,
    retryAfterMs: input.retryAfterMs ?? input.metadata.retryAfterMs,
    errorCode: input.code,
    errorDetail: input.error.slice(0, 500),
  };
  return {
    ok: false,
    error: input.error,
    ...(typeof metadata.status === "number" ? { status: metadata.status } : {}),
    code: input.code,
    retryable: input.retryable,
    retryAfterMs: metadata.retryAfterMs,
    metadata,
  };
}

async function attemptImage(
  input: GenerateImageInput,
  timeoutMs: number,
): Promise<ImageGenerationResult> {
  const { model } = input;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return failureResult({
      code: "CONFIGURATION",
      retryable: false,
      error: "OPENROUTER_API_KEY is not configured.",
      metadata: baseMetadata(model, null),
    });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "Mavly",
  };
  if (appUrl) headers["HTTP-Referer"] = appUrl;

  const body: Record<string, unknown> = {
    model: model.id,
    prompt: input.prompt,
    n: model.maxImages,
    aspect_ratio: input.aspectRatio,
    output_format: input.outputFormat,
  };
  if (typeof input.seed === "number") body.seed = input.seed;

  try {
    const response = await fetch(OPENROUTER_IMAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: input.signal ?? AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Keep the status; the body may be plain text from a proxy.
    }

    const retryAfterMs =
      parseRetryAfterMs(response.headers.get("retry-after")) ??
      parseRetryAfterMs(response.headers.get("x-ratelimit-reset-requests"));
    const metadata = baseMetadata(model, response.status);
    metadata.retryAfterMs = retryAfterMs;
    metadata.providerRequestId = providerRequestId(payload, response.headers);

    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      const detail = providerErrorDetail(payload) || text.slice(0, 500);
      return failureResult({
        code: classified.code,
        retryable: classified.retryable,
        status: response.status,
        retryAfterMs,
        error: `OpenRouter image request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        metadata,
      });
    }

    // A 200 can still carry an error envelope.
    const providerError = providerErrorDetail(payload);
    if (providerError) {
      return failureResult({
        code: "PROVIDER_ERROR",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: `OpenRouter reported an error: ${providerError}`,
        metadata,
      });
    }

    const parsed = parseImageResponse(payload);
    if (parsed.ok === false) {
      return failureResult({
        code: parsed.code,
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: parsed.error,
        metadata,
      });
    }

    return {
      ok: true,
      image: parsed.image,
      model: model.id,
      usage: parsed.usage,
      metadata,
    };
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(message);
    return failureResult({
      code: timedOut ? "TIMEOUT" : "NETWORK",
      retryable: false,
      error: timedOut
        ? "OpenRouter did not return the image before the request deadline."
        : `OpenRouter image request failed: ${message}`,
      metadata: baseMetadata(model, null),
    });
  }
}

function classifyHttpFailure(status: number): {
  code: ImageGenerationErrorCode;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { code: "AUTHENTICATION", retryable: false };
  if (status === 402) return { code: "PROVIDER_ERROR", retryable: false };
  if (status === 408) return { code: "TRANSIENT", retryable: false };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 422) {
    return { code: "INVALID_REQUEST", retryable: false };
  }
  if (status >= 500 && status !== 501 && status !== 505) {
    return { code: "TRANSIENT", retryable: true };
  }
  return { code: "PROVIDER_ERROR", retryable: false };
}

export type ImageResponseParse =
  | { ok: true; image: GeneratedImage; usage: ImageGenerationUsage }
  | { ok: false; code: "EMPTY_RESPONSE" | "INVALID_RESPONSE"; error: string };

/**
 * Read one image out of the provider's buffered response.
 *
 * Requires at least one entry with `b64_json`; the FIRST usable image is
 * returned (this model accepts `n: 1`, so a second would mean the provider
 * ignored the cap — still only one is ever shown or billed into a response).
 */
export function parseImageResponse(payload: unknown): ImageResponseParse {
  if (!payload || typeof payload !== "object") {
    return { ok: false, code: "EMPTY_RESPONSE", error: "OpenRouter returned no response body." };
  }

  const usage = imageUsage(payload);
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    // A URL-only payload is refused, not fetched — see the module note.
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      error: "OpenRouter returned no generated image data.",
    };
  }

  let sawUrlOnly = false;
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const raw = record.b64_json;
    if (typeof raw !== "string" || !raw.trim()) {
      if (typeof record.url === "string" && record.url.trim()) sawUrlOnly = true;
      continue;
    }

    const base64 = stripDataUrlPrefix(raw);
    if (base64.length > MAX_BASE64_CHARS) {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        error: "OpenRouter returned an image larger than Mavly accepts.",
      };
    }
    if (!isPlausibleBase64(base64)) {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        error: "OpenRouter returned image data that is not valid base64.",
      };
    }

    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) {
      return {
        ok: false,
        code: "EMPTY_RESPONSE",
        error: "OpenRouter returned an empty image.",
      };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        error: "OpenRouter returned an image larger than Mavly accepts.",
      };
    }

    const sniffed = sniffImageFormat(bytes);
    if (!sniffed) {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        error: "OpenRouter returned data that is not a PNG or JPEG image.",
      };
    }

    return {
      ok: true,
      image: {
        base64,
        mediaType: sniffed.mediaType,
        format: sniffed.format,
        bytes: bytes.length,
      },
      usage,
    };
  }

  return {
    ok: false,
    code: sawUrlOnly ? "INVALID_RESPONSE" : "EMPTY_RESPONSE",
    error: sawUrlOnly
      ? "OpenRouter returned an image URL instead of image bytes, which Mavly does not fetch."
      : "OpenRouter returned an empty image.",
  };
}

/** PNG and JPEG signatures only: the bytes, not the provider's claim, decide. */
export function sniffImageFormat(
  bytes: Uint8Array,
): { mediaType: "image/png" | "image/jpeg"; format: ImageOutputFormat } | null {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => bytes[index] === byte)) {
      return { mediaType: "image/png", format: "png" };
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: "image/jpeg", format: "jpeg" };
  }
  return null;
}

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim();
  const match = /^data:[^,]*;base64,/i.exec(trimmed);
  const body = match ? trimmed.slice(match[0].length) : trimmed;
  return body.replace(/\s+/g, "");
}

function isPlausibleBase64(value: string): boolean {
  if (value.length < 8 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function imageUsage(payload: unknown): ImageGenerationUsage {
  const usage =
    payload && typeof payload === "object"
      ? (payload as { usage?: unknown }).usage
      : null;
  if (!usage || typeof usage !== "object") return { ...EMPTY_USAGE };
  const record = usage as Record<string, unknown>;
  const promptTokens = numericValue(record.prompt_tokens);
  const completionTokens = numericValue(record.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      numericValue(record.total_tokens) ??
      (promptTokens !== null && completionTokens !== null
        ? promptTokens + completionTokens
        : null),
    costUsd: numericValue(record.cost),
  };
}

function providerErrorDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 500);
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const message = record.message;
  if (typeof message === "string" && message.trim()) return message.slice(0, 500);
  const code = record.code;
  return typeof code === "string" && code.trim() ? code.slice(0, 200) : null;
}

function providerRequestId(payload: unknown, headers: Headers | null): string | null {
  if (headers) {
    for (const name of ["x-request-id", "x-openrouter-request-id", "openrouter-processing-id"]) {
      const value = headers.get(name)?.trim();
      if (value) return value.slice(0, 200);
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["id", "request_id", "provider_request_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
