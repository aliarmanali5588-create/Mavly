/**
 * OpenRouter chat-completions client.
 *
 * ⚠️ SERVER-ONLY. `OPENROUTER_API_KEY` never leaves this module; it is not a
 * `NEXT_PUBLIC_` variable and must never be returned in an API response or log.
 *
 * The result contract, response parsing and failure classification live in
 * `./chat-contract.ts`; this file handles the OpenRouter-specific endpoint,
 * credential and attribution headers.
 *
 * ═══ WHAT A RESULT CARRIES NOW ══════════════════════════════════════════════
 *
 * The agent needs more than "text or an error" to recover safely:
 *
 *   · `finish_reason` — `length` is a TRUNCATION, never a success, regardless of
 *     whether the bytes happen to end with a closing brace;
 *   · token usage (including reasoning tokens) — recorded for every attempt;
 *   · the model the provider actually used, the HTTP status and the provider
 *     request id — safe observability without leaking the key;
 *   · a numeric `Retry-After` — so a rate-limited response waits as instructed
 *     instead of being retried immediately.
 *
 * Nothing here decides how many times to retry; that is `retry.ts`. This module
 * only classifies each single response.
 */

import type { AiModel } from "./models";
import { OPENROUTER_MODEL_CATALOG } from "./models";
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

/**
 * The shared contract is provider-neutral and lives in `./chat-contract.ts`.
 * Re-exported here so existing importers of this module keep working.
 */
export { isChatCompletionFailure } from "./chat-contract";
export {
  completionContent,
  completionFinishReason,
  completionModel,
  completionUsage,
  providerRequestId,
} from "./chat-contract";
export type {
  ChatCompletionErrorCode,
  ChatCompletionFailure,
  ChatCompletionMetadata,
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatCompletionSuccess,
  ChatCompletionUsage,
  ChatMessage,
} from "./chat-contract";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-openrouter-request-id",
  "openrouter-processing-id",
] as const;

export function isAiConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim();
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

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return failureResult({
      code: "CONFIGURATION",
      retryable: false,
      error: "OPENROUTER_API_KEY is not configured.",
      metadata: baseMetadata(model, null),
    });
  }

  /**
   * ⚠️ CATALOG MEMBERSHIP IS CHECKED BEFORE ANY NETWORK CALL. This is the last
   * gate between a resolved model and the wire: a stale `MAVLY_DEFAULT_MODEL`, a
   * client-supplied ID or a retired provider alias must fail here rather than be
   * forwarded and rejected upstream (or, worse, silently served by another model).
   */
  if (!OPENROUTER_MODEL_CATALOG.some((candidate) => candidate.id === model.id)) {
    return failureResult({
      code: "INVALID_REQUEST",
      retryable: false,
      error: `The requested OpenRouter model "${model.id}" is not in Mavly's supported model catalog.`,
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

  const requestedMax = opts.maxTokens ?? model.maxOutputTokens;
  const maxTokens =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.floor(requestedMax), model.maxOutputTokens)
      : model.maxOutputTokens;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
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
      // Keep the status; the body may be plain text from a proxy.
    }

    const retryAfterMs =
      parseRetryAfterMs(response.headers.get("retry-after")) ??
      parseRetryAfterMs(response.headers.get("x-ratelimit-reset-requests"));
    const metadata = metadataFromPayload(
      model,
      payload,
      response.status,
      retryAfterMs,
      response.headers,
      OPENROUTER_REQUEST_ID_HEADERS,
    );

    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      const detail = redactSecret(providerErrorDetail(payload) || text.slice(0, 500), apiKey);
      return failureResult({
        code: classified.code,
        retryable: classified.retryable,
        status: response.status,
        retryAfterMs,
        error: `OpenRouter request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        metadata,
      });
    }

    // OpenRouter can answer 200 with an error envelope. Do not treat that as a
    // completion just because the HTTP status is green.
    if (providerErrorDetail(payload)) {
      return failureResult({
        code: "PROVIDER_ERROR",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: `OpenRouter reported an error: ${redactSecret(providerErrorDetail(payload) ?? "", apiKey)}`,
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
          "OpenRouter stopped at the model's output limit before returning a complete answer. The incomplete response was discarded.",
        metadata,
      });
    }
    if (finishReason === "content_filter") {
      return failureResult({
        code: "CONTENT_FILTER",
        retryable: false,
        status: response.status,
        retryAfterMs,
        error: "OpenRouter blocked the response with its content filter. Nothing was saved.",
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
        error: `OpenRouter reported an error${detail ? `: ${redactSecret(detail, apiKey)}` : "."}`,
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
          `OpenRouter returned an empty completion.${detail ? ` ${detail}` : ""}`,
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
        ? "OpenRouter did not answer before the request deadline."
        : redactSecret(`OpenRouter request failed: ${message}`, apiKey),
      metadata: baseMetadata(model, null),
    });
  }
}
