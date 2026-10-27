/**
 * ═══ PROVIDER-NEUTRAL CHAT COMPLETIONS CONTRACT ══════════════════════════════
 *
 * Mavly can serve website/Android source generation from more than one
 * OpenAI-compatible text provider (OpenRouter, and Token Harbor for
 * controlled evaluation). The generation pipeline must not care which one
 * answered, so the result contract, the response parsing and the failure
 * classification live here, and each adapter supplies only what genuinely
 * differs: endpoint, credential, request headers/body and its own error
 * wording.
 *
 * ═══ WHAT A RESULT CARRIES ══════════════════════════════════════════════════
 *
 * The agent needs more than "text or an error" to recover safely:
 *
 *   · `finish_reason` — `length` is a TRUNCATION, never a success, regardless of
 *     whether the bytes happen to end with a closing brace;
 *   · token usage (including reasoning tokens) — recorded for every attempt;
 *   · the model the provider actually used, the HTTP status and the provider
 *     request id — safe observability without leaking a key;
 *   · a numeric `Retry-After` — so a rate-limited response waits as instructed
 *     instead of being retried immediately.
 *
 * Nothing here decides how many times to retry; that is `retry.ts`. Nothing
 * here performs I/O, reads the environment or knows a credential name: this
 * module is pure, and it never invents a value the provider did not supply.
 */

import type { AiModel } from "./models";

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
  /** Present only when the provider reports it. Never estimated. */
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

export const EMPTY_USAGE: ChatCompletionUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  reasoningTokens: null,
  costUsd: null,
};

export function baseMetadata(model: AiModel, status: number | null): ChatCompletionMetadata {
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

export function failureResult(input: {
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

/**
 * HTTP status → the repository's existing error codes. `402` is classified as a
 * non-retryable provider error for every provider (an account/quota condition
 * does not fix itself); the adapter supplies the wording.
 */
export function classifyHttpFailure(status: number): {
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

export function metadataFromPayload(
  model: AiModel,
  payload: unknown,
  status: number,
  retryAfterMs: number | null,
  headers: Headers,
  requestIdHeaders: readonly string[],
): ChatCompletionMetadata {
  return {
    status,
    requestedModel: model.id,
    model: completionModel(payload) ?? model.id,
    finishReason: completionFinishReason(payload),
    usage: completionUsage(payload),
    providerRequestId: providerRequestId(payload, headers, requestIdHeaders),
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
  headerNames: readonly string[] = ["x-request-id"],
): string | null {
  if (headers) {
    for (const name of headerNames) {
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

export function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

export function completionMessage(payload: unknown): Record<string, unknown> | null {
  const first = firstChoice(payload);
  if (!first) return null;
  const message = first.message;
  return message && typeof message === "object" ? (message as Record<string, unknown>) : null;
}

export function contentText(content: unknown): string | null {
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

export function emptyCompletionDetail(payload: unknown): string {
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

export function providerErrorDetail(payload: unknown): string | null {
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

export function objectValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
}

export function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * A provider or proxy can echo request material in an error body. The key must
 * never reach a response, a run row or a log, so every outbound error string is
 * scrubbed and bounded here.
 */
export function redactSecret(value: string, apiKey: string): string {
  if (!apiKey) return value.slice(0, 500);
  return value.split(apiKey).join("[redacted]").slice(0, 500);
}
