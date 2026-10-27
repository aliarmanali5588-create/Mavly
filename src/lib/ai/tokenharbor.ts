/**
 * Token Harbor chat-completions client.
 *
 * ⚠️ SERVER-ONLY. `TOKEN_HARBOR_API_KEY` never leaves this module; it must never
 * be given a `NEXT_PUBLIC_` prefix, returned in an API response, written to a
 * log, or injected into a generated application's environment.
 *
 * Token Harbor exposes an OpenAI-compatible chat-completions API, so the result
 * contract, the response parsing and the failure classification are the shared
 * ones in `./chat-contract.ts`. This file holds only what is Token Harbor's:
 * the endpoint, the credential, the request shape and the provider wording.
 *
 * ═══ DELIBERATE LIMITS ═══════════════════════════════════════════════════════
 *
 *   · ONLY the model ids in `TOKEN_HARBOR_MODEL_CATALOG` may be requested. The
 *     catalog is checked before any network call, so a stale override, a
 *     client-supplied id or an OpenRouter-style id (`vendor/model`) fails here
 *     instead of being forwarded to the provider.
 *   · No OpenRouter attribution headers are sent. Token Harbor is not
 *     documented to consume `X-Title`/`HTTP-Referer`, and an adapter must not
 *     claim support for an option it cannot verify.
 *   · This adapter never retries by itself. Bounded retry, backoff and
 *     `Retry-After` handling belong to the caller (`./retry.ts`), so a retry
 *     cannot loop unbounded inside a single provider call.
 *   · Only text completions. Token Harbor is used for website/Android SOURCE
 *     generation; image generation stays on its existing OpenRouter image path
 *     and is never routed here on the strength of an input modality.
 */

import type { AiModel } from "./models";
import { TOKEN_HARBOR_MODEL_CATALOG } from "./models";
import { parseRetryAfterMs } from "./retry";
import {
  baseMetadata,
  classifyHttpFailure,
  completionContent,
  completionFinishReason,
  completionModel,
  emptyCompletionDetail,
  failureResult,
  metadataFromPayload,
  providerErrorDetail,
  redactSecret,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessage,
} from "./chat-contract";

export const TOKEN_HARBOR_DEFAULT_BASE_URL = "https://tokenharbor.ai/v1";

const CHAT_COMPLETIONS_PATH = "chat/completions";
const TOKEN_HARBOR_REQUEST_ID_HEADERS = ["x-request-id", "x-tokenharbor-request-id"] as const;

export type TokenHarborBaseUrlResolution =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: string };

/**
 * The base URL is operator configuration, never client input. It is validated
 * rather than trusted: an unparseable value, a non-HTTPS scheme, embedded
 * credentials or a query/fragment is a configuration failure, not a silently
 * accepted request target.
 */
export function resolveTokenHarborBaseUrl(
  raw: string | undefined = process.env.TOKEN_HARBOR_BASE_URL,
): TokenHarborBaseUrlResolution {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, baseUrl: TOKEN_HARBOR_DEFAULT_BASE_URL };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "TOKEN_HARBOR_BASE_URL is not a valid absolute URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "TOKEN_HARBOR_BASE_URL must use https." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "TOKEN_HARBOR_BASE_URL must not embed credentials." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: "TOKEN_HARBOR_BASE_URL must not contain a query string or fragment." };
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: `${parsed.origin}${path}` };
}

/**
 * A provider error body can say a model is unavailable without an HTTP status
 * that means it. This only classifies what the provider actually said; it never
 * guesses a payment or availability state the provider did not report.
 */
export function looksLikeUnsupportedModel(detail: string | null): boolean {
  if (!detail) return false;
  if (!/\bmodels?\b/i.test(detail)) return false;
  return /(not found|not_found|not supported|unsupported|unknown|unavailable|does not exist|invalid|no such|missing|access denied|not available)/i.test(
    detail,
  );
}

export function isAiConfigured(): boolean {
  return !!process.env.TOKEN_HARBOR_API_KEY?.trim();
}

/**
 * One completion. The timeout is supplied by the caller and bounded by the
 * run's remaining budget; a provider that hangs must not leave a run stuck in
 * `init` forever.
 */
export async function chatCompletion(
  model: AiModel,
  messages: ChatMessage[],
  options: number | ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const opts: ChatCompletionOptions =
    typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 240_000;

  const apiKey = process.env.TOKEN_HARBOR_API_KEY?.trim();
  if (!apiKey) {
    return failureResult({
      code: "CONFIGURATION",
      retryable: false,
      error: "TOKEN_HARBOR_API_KEY is not configured.",
      metadata: baseMetadata(model, null),
    });
  }

  const base = resolveTokenHarborBaseUrl();
  if (!base.ok) {
    return failureResult({
      code: "CONFIGURATION",
      retryable: false,
      error: `Token Harbor is not configured: ${base.reason}`,
      metadata: baseMetadata(model, null),
    });
  }

  /**
   * ⚠️ CATALOG MEMBERSHIP IS CHECKED BEFORE ANY NETWORK CALL. Only Mavly-owned,
   * server-side model ids may reach the wire — never a browser value, a
   * generated-application value or an id belonging to another provider.
   */
  if (!TOKEN_HARBOR_MODEL_CATALOG.some((candidate) => candidate.id === model.id)) {
    return failureResult({
      code: "INVALID_REQUEST",
      retryable: false,
      error: `The requested Token Harbor model "${model.id}" is not in Mavly's supported model catalog.`,
      metadata: baseMetadata(model, null),
    });
  }

  const requestedMax = opts.maxTokens ?? model.maxOutputTokens;
  const maxTokens =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.floor(requestedMax), model.maxOutputTokens)
      : model.maxOutputTokens;

  try {
    const response = await fetch(`${base.baseUrl}/${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: maxTokens,
      }),
      cache: "no-store",
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Keep the status; the body may be plain text from a proxy or a gateway.
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const metadata = metadataFromPayload(
      model,
      payload,
      response.status,
      retryAfterMs,
      response.headers,
      TOKEN_HARBOR_REQUEST_ID_HEADERS,
    );

    if (!response.ok) {
      const detail = redactSecret(providerErrorDetail(payload) || text.slice(0, 500), apiKey);
      const classified = classifyHttpFailure(response.status);

      if (response.status === 402) {
        return failureResult({
          code: classified.code,
          retryable: classified.retryable,
          status: response.status,
          retryAfterMs,
          error: `Token Harbor reported no remaining credit or quota for "${model.id}"${detail ? `: ${detail}` : "."}`,
          metadata,
        });
      }
      if (
        classified.code === "INVALID_REQUEST" &&
        (looksLikeUnsupportedModel(detail) || response.status === 404)
      ) {
        return failureResult({
          code: "INVALID_REQUEST",
          retryable: false,
          status: response.status,
          retryAfterMs,
          error: `Token Harbor does not serve the requested model "${model.id}"${detail ? `: ${detail}` : "."}`,
          metadata,
        });
      }

      return failureResult({
        code: classified.code,
        retryable: classified.retryable,
        status: response.status,
        retryAfterMs,
        error: `Token Harbor request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        metadata,
      });
    }

    // A green HTTP status can still carry an error envelope. Do not treat that
    // as a completion.
    const envelope = providerErrorDetail(payload);
    if (envelope) {
      const detail = redactSecret(envelope, apiKey);
      if (looksLikeUnsupportedModel(detail)) {
        return failureResult({
          code: "INVALID_REQUEST",
          retryable: false,
          status: response.status,
          retryAfterMs,
          error: `Token Harbor does not serve the requested model "${model.id}": ${detail}`,
          metadata,
        });
      }
      return failureResult({
        code: "PROVIDER_ERROR",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: `Token Harbor reported an error: ${detail}`,
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
        error:
          "Token Harbor stopped at the model's output limit before returning a complete answer. The incomplete response was discarded.",
        metadata,
      });
    }
    if (finishReason === "content_filter") {
      return failureResult({
        code: "CONTENT_FILTER",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: "Token Harbor blocked the response with its content filter. Nothing was saved.",
        metadata,
      });
    }
    if (finishReason === "error") {
      const detail = providerErrorDetail(payload);
      return failureResult({
        code: "PROVIDER_ERROR",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: `Token Harbor reported an error${detail ? `: ${redactSecret(detail, apiKey)}` : "."}`,
        metadata,
      });
    }

    const content = completionContent(payload);
    if (!content) {
      const detail = emptyCompletionDetail(payload);
      return failureResult({
        code: "EMPTY_COMPLETION",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: redactSecret(
          `Token Harbor returned an empty completion.${detail ? ` ${detail}` : ""}`,
          apiKey,
        ),
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
    const timedOut = name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(message);
    return failureResult({
      code: timedOut ? "TIMEOUT" : "NETWORK",
      retryable: true,
      error: timedOut
        ? "Token Harbor did not answer before the request deadline."
        : redactSecret(`Token Harbor request failed: ${message}`, apiKey),
      metadata: baseMetadata(model, null),
    });
  }
}
