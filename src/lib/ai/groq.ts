/**
 * FreeModel chat-completions client for server-side website/code generation.
 *
 * FREEMODEL_API_KEY is read only here and must never be exposed to browser code,
 * API responses, or logs.
 */

import type { AiModel } from "./models";
import { AI_MODEL_CATALOG } from "./models";
import { parseRetryAfterMs } from "./retry";

const DEFAULT_FREEMODEL_BASE_URL = "https://freemodel.in/v1";

function freemodelBaseUrl(): string {
  return (process.env.FREEMODEL_BASE_URL?.trim() || DEFAULT_FREEMODEL_BASE_URL).replace(/\/+$/, "");
}

function freemodelApiKey(): string | undefined {
  return process.env.FREEMODEL_API_KEY?.trim() || undefined;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatCompletionErrorCode =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "TIMEOUT"
  | "NETWORK"
  | "CONTENT_FILTER"
  | "OUTPUT_LIMIT"
  | "EMPTY_COMPLETION"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

export interface ChatCompletionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export interface ChatCompletionMetadata {
  status: number | null;
  requestedModel: string;
  model: string | null;
  finishReason: string | null;
  usage: ChatCompletionUsage;
  providerRequestId: string | null;
  retryAfterMs: number | null;
  errorCode: ChatCompletionErrorCode | null;
  errorDetail: string | null;
}

export interface ChatCompletionSuccess {
  ok: true;
  content: string;
  model: string;
  finishReason: string | null;
  truncated: false;
  metadata: ChatCompletionMetadata;
}

export interface ChatCompletionFailure {
  ok: false;
  error: string;
  status?: number;
  code: ChatCompletionErrorCode;
  retryable: boolean;
  retryAfterMs: number | null;
  metadata: ChatCompletionMetadata;
}

export type ChatCompletionResult = ChatCompletionSuccess | ChatCompletionFailure;

export interface ChatCompletionOptions {
  timeoutMs?: number;
  /** Overrides the model's output cap for bounded agent batches. */
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

const EMPTY_USAGE: ChatCompletionUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  reasoningTokens: null,
  costUsd: null,
};

export function isChatCompletionFailure(
  result: ChatCompletionResult,
): result is ChatCompletionFailure {
  return result.ok === false;
}

export function isAiConfigured(): boolean {
  return !!freemodelApiKey();
}

/**
 * Make one non-streaming completion. The caller owns retries and supplies the
 * timeout bounded by the durable run's remaining wall-clock budget.
 */
export async function chatCompletion(
  model: AiModel,
  messages: ChatMessage[],
  options: number | ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const opts: ChatCompletionOptions =
    typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const apiKey = freemodelApiKey();

  if (!apiKey) {
    return failureResult({
      code: "CONFIGURATION",
      retryable: false,
      error: "FREEMODEL_API_KEY is not configured.",
      metadata: baseMetadata(model, null),
    });
  }

  if (!AI_MODEL_CATALOG.some((candidate) => candidate.id === model.id)) {
    return failureResult({
      code: "INVALID_REQUEST",
      retryable: false,
      error: `The requested FreeModel model "${model.id}" is not in Mavly's supported model catalog.`,
      metadata: baseMetadata(model, null),
    });
  }

  const requestedMax = opts.maxTokens ?? model.maxOutputTokens;
  const maxCompletionTokens =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.floor(requestedMax), model.maxOutputTokens)
      : model.maxOutputTokens;

  try {
    const response = await fetch(`${freemodelBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_completion_tokens: maxCompletionTokens,
        stream: false,
      }),
      cache: "no-store",
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Keep the HTTP status; a proxy can return a non-JSON error body.
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const metadata = metadataFromPayload(model, payload, response.status, retryAfterMs, response.headers);

    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      const detail = redactSecret(providerErrorDetail(payload) || text, apiKey);
      return failureResult({
        code: classified.code,
        retryable: classified.retryable,
        status: response.status,
        retryAfterMs,
        error: `FreeModel request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        metadata,
      });
    }

    const providerError = providerErrorDetail(payload);
    if (providerError) {
      return failureResult({
        code: "PROVIDER_ERROR",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: `FreeModel reported an error: ${redactSecret(providerError, apiKey)}`,
        metadata,
      });
    }

    const finishReason = completionFinishReason(payload);
    metadata.finishReason = finishReason;

    if (finishReason === "length") {
      return failureResult({
        code: "OUTPUT_LIMIT",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: "FreeModel stopped at the model's output limit before returning a complete answer. The incomplete response was discarded.",
        metadata,
      });
    }
    if (finishReason === "content_filter") {
      return failureResult({
        code: "CONTENT_FILTER",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: "FreeModel blocked the response with its content filter. Nothing was saved.",
        metadata,
      });
    }
    if (finishReason === "error") {
      return failureResult({
        code: "PROVIDER_ERROR",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: `FreeModel reported an error${providerError ? `: ${providerError}` : "."}`,
        metadata,
      });
    }

    const content = completionContent(payload);
    if (!content) {
      return failureResult({
        code: "EMPTY_COMPLETION",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: "FreeModel returned an empty completion.",
        metadata,
      });
    }

    const actualModel = completionModel(payload) || model.id;
    metadata.model = actualModel;
    return {
      ok: true,
      content,
      model: actualModel,
      finishReason,
      truncated: false,
      metadata,
    };
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      name === "TimeoutError" ||
      name === "AbortError" ||
      /timed? ?out|aborted/i.test(message);
    return failureResult({
      code: timedOut ? "TIMEOUT" : "NETWORK",
      retryable: true,
      error: timedOut
        ? "FreeModel did not answer before the request deadline."
        : `FreeModel request failed: ${redactSecret(message, apiKey)}`,
      metadata: baseMetadata(model, null),
    });
  }
}

export function completionUsage(payload: unknown): ChatCompletionUsage {
  const usage = objectValue(payload, "usage");
  if (!usage) return { ...EMPTY_USAGE };

  const promptTokens = numericValue(usage.prompt_tokens);
  const completionTokens = numericValue(usage.completion_tokens);
  const details = objectValue(usage, "completion_tokens_details");
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      numericValue(usage.total_tokens) ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
    reasoningTokens:
      numericValue(details?.reasoning_tokens) ?? numericValue(usage.reasoning_tokens),
    costUsd: numericValue(usage.cost),
  };
}

export function completionFinishReason(payload: unknown): string | null {
  const first = firstChoice(payload);
  const reason = first?.finish_reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

export function completionContent(payload: unknown): string | null {
  const first = firstChoice(payload);
  const message = first?.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
  return text.trim() ? text : null;
}

export function completionModel(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const model = (payload as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

export function providerRequestId(payload: unknown, headers: Headers): string | null {
  const headerId = headers.get("x-request-id")?.trim();
  if (headerId) return headerId.slice(0, 200);
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim().slice(0, 200) : null;
}

function baseMetadata(model: AiModel, status: number | null): ChatCompletionMetadata {
  return {
    status,
    requestedModel: model.id,
    model: null,
    finishReason: null,
    usage: { ...EMPTY_USAGE },
    providerRequestId: null,
    retryAfterMs: null,
    errorCode: null,
    errorDetail: null,
  };
}

function failureResult(input: {
  code: ChatCompletionErrorCode;
  retryable: boolean;
  error: string;
  status?: number;
  retryAfterMs?: number | null;
  metadata: ChatCompletionMetadata;
}): ChatCompletionFailure {
  const metadata: ChatCompletionMetadata = {
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

function classifyHttpFailure(status: number): {
  code: ChatCompletionErrorCode;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { code: "AUTHENTICATION", retryable: false };
  if (status === 402) return { code: "PROVIDER_ERROR", retryable: false };
  if (status === 408) return { code: "TRANSIENT", retryable: true };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if ([400, 404, 405, 409, 422].includes(status)) {
    return { code: "INVALID_REQUEST", retryable: false };
  }
  if (status >= 500 && status !== 501 && status !== 505) {
    return { code: "TRANSIENT", retryable: true };
  }
  return { code: "PROVIDER_ERROR", retryable: false };
}

function metadataFromPayload(
  model: AiModel,
  payload: unknown,
  status: number,
  retryAfterMs: number | null,
  headers: Headers,
): ChatCompletionMetadata {
  return {
    status,
    requestedModel: model.id,
    model: completionModel(payload) ?? model.id,
    finishReason: completionFinishReason(payload),
    usage: completionUsage(payload),
    providerRequestId: providerRequestId(payload, headers),
    retryAfterMs,
    errorCode: null,
    errorDetail: null,
  };
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

function objectValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function providerErrorDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 500);
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.slice(0, 500);
  }
  return typeof record.code === "string" && record.code.trim()
    ? record.code.slice(0, 200)
    : null;
}

function redactSecret(value: string, apiKey: string): string {
  return value.split(apiKey).join("[redacted]").slice(0, 500);
}
