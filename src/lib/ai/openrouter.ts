/**
 * OpenRouter chat-completions client.
 *
 * ⚠️ SERVER-ONLY. `OPENROUTER_API_KEY` never leaves this module; it is not a
 * `NEXT_PUBLIC_` variable and must never be returned in an API response or log.
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
import { parseRetryAfterMs } from "./retry";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
  /** Present when the provider reports it (OpenRouter does for paid usage). */
  costUsd: number | null;
}

/**
 * Safe provider metadata. It never contains the API key, request headers or an
 * unbounded provider payload. `errorDetail` is truncated and only present on a
 * failure.
 */
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
  /** A successful response is never truncated. */
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
  /** Overrides the model's cap for this call (used by bounded batches). */
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export function isChatCompletionFailure(
  result: ChatCompletionResult,
): result is ChatCompletionFailure {
  return result.ok === false;
}

export function isAiConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim();
}

const EMPTY_USAGE: ChatCompletionUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  reasoningTokens: null,
  costUsd: null,
};

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
    );

    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      const detail = providerErrorDetail(payload) || text.slice(0, 500);
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
        error: `OpenRouter reported an error: ${providerErrorDetail(payload)}`,
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
        error: `OpenRouter reported an error${detail ? `: ${detail}` : "."}`,
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
        error: `OpenRouter returned an empty completion.${detail ? ` ${detail}` : ""}`,
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
        : `OpenRouter request failed: ${message}`,
      metadata: baseMetadata(model, null),
    });
  }
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
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 422) {
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

export function completionUsage(payload: unknown): ChatCompletionUsage {
  const usage = objectValue(payload, "usage");
  if (!usage) return { ...EMPTY_USAGE };

  const promptTokens = numericValue(usage.prompt_tokens);
  const completionTokens = numericValue(usage.completion_tokens);
  const totalTokens =
    numericValue(usage.total_tokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);

  const details = usage.completion_tokens_details;
  const detailObject = details && typeof details === "object" ? (details as Record<string, unknown>) : null;
  const reasoningTokens =
    numericValue(detailObject?.reasoning_tokens) ?? numericValue(usage.reasoning_tokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    costUsd: numericValue(usage.cost),
  };
}

export function completionFinishReason(payload: unknown): string | null {
  const first = firstChoice(payload);
  const reason = first?.finish_reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

export function completionModel(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const model = (payload as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

export function completionContent(payload: unknown): string | null {
  const message = completionMessage(payload);
  if (message) {
    const content = contentText(message.content);
    if (content) return content;
  }
  const first = firstChoice(payload);
  return first ? contentText(first.text) : null;
}

export function providerRequestId(
  payload: unknown,
  headers: Headers | null,
): string | null {
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

function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

function completionMessage(payload: unknown): Record<string, unknown> | null {
  const first = firstChoice(payload);
  if (!first) return null;
  const message = first.message;
  return message && typeof message === "object" ? (message as Record<string, unknown>) : null;
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
  return text.trim() ? text : null;
}

function emptyCompletionDetail(payload: unknown): string {
  const first = firstChoice(payload);
  if (!first) return "The response contained no choices.";

  const message = completionMessage(payload) ?? {};
  const finishReason = completionFinishReason(payload);
  const refusal = message.refusal;
  const reasoning = message.reasoning;
  const details: string[] = [];

  if (typeof refusal === "string" && refusal.trim()) {
    details.push(`The model refused: ${refusal.trim().slice(0, 300)}`);
  }
  if (typeof reasoning === "string" && reasoning.trim()) {
    details.push("The model returned reasoning text but no final answer.");
  }
  if (finishReason === "tool_calls") {
    details.push("The model returned tool calls instead of text, which Mavly does not support.");
  } else if (finishReason) {
    details.push(`The provider finished with reason "${finishReason}".`);
  }

  const provider = providerErrorDetail(payload);
  if (provider) details.push(provider);

  return details.join(" ");
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

function objectValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
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
