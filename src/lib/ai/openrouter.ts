/**
 * OpenRouter chat-completions client.
 *
 * ⚠️ SERVER-ONLY. `OPENROUTER_API_KEY` never leaves this module; it is not a
 * `NEXT_PUBLIC_` variable and must never be returned in an API response or log.
 *
 * The result contract, response parsing and failure classification live in
 * `./chat-contract.ts`; the streamed-accumulation rules live in
 * `./stream-contract.ts`. This file owns the OpenRouter endpoint, credential,
 * attribution headers and the TRANSPORT.
 *
 * ═══ STREAMED, PROGRESS-BOUNDED TRANSPORT ═══════════════════════════════════
 *
 * The old transport awaited one complete non-streaming body under a single
 * total-response timeout. A large but healthy generation was therefore aborted
 * for being slow, and the abort was retried with the same scope — several paid
 * requests for no files.
 *
 * Now every request is streamed and bounded by TWO clocks:
 *
 *   · an IDLE window (`idleTimeoutMs`) — silence longer than this is a stall;
 *   · an ABSOLUTE cap (`timeoutMs`) — the phase's configured call window, which
 *     the caller has already fitted inside the run's remaining budget.
 *
 * A chunk arriving is progress. A long answer that keeps arriving is never
 * aborted merely for being long.
 *
 * ═══ WHAT A RESULT CARRIES ══════════════════════════════════════════════════
 *
 *   · `finish_reason` — `length` is a TRUNCATION and is never a success;
 *   · the completion verdict from `streamCompletionVerdict` — a cancelled,
 *     incomplete or unknown-reason stream is a failure even when text arrived;
 *   · token usage (including reasoning tokens) — recorded for every attempt;
 *   · the model the provider actually used, the HTTP status and the provider
 *     request id even when the body later fails, so an aborted request can be
 *     reconciled against the provider's own records;
 *   · a numeric `Retry-After` — so a rate-limited response waits as instructed.
 *
 * Nothing here decides how many times to retry; that is `retry.ts` plus the
 * call policy in `agent.ts`.
 */

import type { AiModel } from "./models";
import { OPENROUTER_MODEL_CATALOG } from "./models";
import { idleTimeoutFor } from "./budget";
import { parseRetryAfterMs } from "./retry";
import {
  EMPTY_USAGE,
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
  type ChatCompletionErrorCode,
  type ChatCompletionMetadata,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessage,
} from "./chat-contract";
import {
  createStreamAccumulator,
  streamCompletionVerdict,
  type StreamSnapshot,
} from "./stream-contract";

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

/** Why a request was aborted locally, as opposed to failing upstream. */
type AbortReason = "idle" | "absolute" | "external";

interface TransportFailureInput {
  code: ChatCompletionErrorCode;
  retryable: boolean;
  error: string;
  status?: number | null;
  retryAfterMs?: number | null;
  partialContent?: string;
  timeoutClassification?: "idle" | "absolute" | "external";
  metadata: ChatCompletionMetadata;
}

const MAX_PERSISTABLE_PARTIAL_BYTES = 128 * 1024;

function persistablePartial(content: string): string | undefined {
  return content && Buffer.byteLength(content, "utf8") <= MAX_PERSISTABLE_PARTIAL_BYTES
    ? content
    : undefined;
}

function failure(input: TransportFailureInput): ChatCompletionResult {
  return failureResult({
    code: input.code,
    retryable: input.retryable,
    error: input.error,
    ...(typeof input.status === "number" ? { status: input.status } : {}),
    retryAfterMs: input.retryAfterMs ?? null,
    ...(input.partialContent ? { partialContent: input.partialContent } : {}),
    ...(input.timeoutClassification
      ? { timeoutClassification: input.timeoutClassification }
      : {}),
    metadata: input.metadata,
  });
}

function headerValue(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 200);
  }
  return null;
}

/**
 * One completion. The caller supplies both clocks; they are already bounded by
 * the run's remaining budget, so a provider that hangs cannot leave a run stuck.
 */
export async function chatCompletion(
  model: AiModel,
  messages: ChatMessage[],
  options: number | ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const opts: ChatCompletionOptions =
    typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 240_000));

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return failure({
      // A missing credential is a configuration failure, not a provider one:
      // the request was refused locally and nothing was billed.
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
    return failure({
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
    Accept: "text/event-stream",
    "X-Title": "Mavly",
  };
  if (appUrl) headers["HTTP-Referer"] = appUrl;

  const requestedMax = opts.maxTokens ?? model.maxOutputTokens;
  const maxTokens =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.floor(requestedMax), model.maxOutputTokens)
      : model.maxOutputTokens;

  const idleTimeoutMs = Math.max(
    1_000,
    Math.min(Math.floor(opts.idleTimeoutMs ?? idleTimeoutFor(timeoutMs)), timeoutMs),
  );

  const controller = new AbortController();
  let abortReason: AbortReason | null = null;
  /**
   * ⚠️ THE READ LOOP MUST EXIT EVEN IF THE BODY STREAM IGNORES THE SIGNAL. The
   * fetch is aborted, but an in-flight `reader.read()` is not guaranteed to
   * reject promptly in every runtime. Racing it against this promise makes the
   * idle/absolute bound unconditional instead of relying on transport behaviour.
   */
  let fireAbort!: () => void;
  const abortSignal = new Promise<null>((resolve) => {
    fireAbort = () => resolve(null);
  });
  const abort = (reason: AbortReason): void => {
    if (abortReason) return;
    abortReason = reason;
    fireAbort();
    controller.abort();
  };
  const onExternalAbort = (): void => abort("external");
  if (opts.signal) {
    if (opts.signal.aborted) abort("external");
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort("idle"), idleTimeoutMs);
  };
  const absoluteTimer = setTimeout(() => abort("absolute"), timeoutMs);
  armIdle();

  const clearTimers = (): void => {
    clearTimeout(absoluteTimer);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    opts.signal?.removeEventListener("abort", onExternalAbort);
  };

  /** Metadata that survives an aborted body: request id, status and any usage. */
  let capturedRequestId: string | null = null;
  let capturedStatus: number | null = null;
  let capturedRetryAfterMs: number | null = null;

  const abortedMetadata = (
    snapshot: StreamSnapshot | null,
    status: number | null,
  ): ChatCompletionMetadata => ({
    status,
    requestedModel: model.id,
    model: snapshot?.model ?? null,
    finishReason: snapshot?.finishReason ?? null,
    usage: snapshot ? { ...snapshot.usage } : { ...EMPTY_USAGE },
    providerRequestId: capturedRequestId,
    retryAfterMs: capturedRetryAfterMs,
    errorCode: "TIMEOUT",
    errorDetail: null,
  });

  const abortFailure = (snapshot: StreamSnapshot | null): ChatCompletionResult => {
    const seconds = Math.max(1, Math.round(idleTimeoutMs / 1_000));
    const reason: AbortReason = abortReason ?? "absolute";
    if (reason === "external") {
      return failure({
        code: "TIMEOUT",
        retryable: false,
        error: "The request was cancelled before the provider finished answering.",
        timeoutClassification: "external",
        metadata: abortedMetadata(snapshot, capturedStatus),
      });
    }
    return failure({
      code: "TIMEOUT",
      retryable: true,
      error:
        reason === "idle"
          ? `OpenRouter stopped sending tokens for ${seconds} s before the response completed.`
          : `OpenRouter did not finish the response within ${Math.round(timeoutMs / 1_000)} s.`,
      partialContent: snapshot ? persistablePartial(snapshot.content) : undefined,
      timeoutClassification: reason,
      metadata: abortedMetadata(snapshot, capturedStatus),
    });
  };

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.id,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    capturedStatus = response.status;
    /**
     * ⚠️ THE REQUEST ID IS CAPTURED BEFORE THE BODY IS READ. When a body fails
     * or is aborted we still need this id to reconcile a billable request
     * against the provider's own records; after a failed read it is gone.
     */
    capturedRequestId = headerValue(response.headers, OPENROUTER_REQUEST_ID_HEADERS);
    capturedRetryAfterMs =
      parseRetryAfterMs(response.headers.get("retry-after")) ??
      parseRetryAfterMs(response.headers.get("x-ratelimit-reset-requests"));

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        // Keep the status; the body may be plain text from a proxy.
      }
      const metadata = metadataFromPayload(
        model,
        payload,
        response.status,
        capturedRetryAfterMs,
        response.headers,
        OPENROUTER_REQUEST_ID_HEADERS,
      );
      const classified = classifyHttpFailure(response.status);
      const detail = redactSecret(providerErrorDetail(payload) || text.slice(0, 500), apiKey);
      return failure({
        code: classified.code,
        retryable: classified.retryable,
        status: response.status,
        retryAfterMs: capturedRetryAfterMs,
        error: `OpenRouter request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        metadata,
      });
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isEventStream =
      contentType.includes("event-stream") || contentType.includes("stream");

    /**
     * A provider or proxy that ignores `stream: true` answers with one JSON
     * object. Reading it as JSON keeps that case correct instead of discarding a
     * completed (and already billed) response.
     */
    if (!isEventStream) {
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        // Fall through to the failure below.
      }
      return interpretJsonCompletion(model, payload, response, capturedRetryAfterMs, apiKey);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return failure({
        code: "NETWORK",
        retryable: true,
        error: "OpenRouter returned a stream with no readable body.",
        metadata: abortedMetadata(null, response.status),
      });
    }

    const accumulator = createStreamAccumulator();
    // A chunk boundary can fall inside a multi-byte UTF-8 sequence, so the
    // decoder must keep its state across chunks; a one-shot per-chunk decode
    // would corrupt any character that straddles a boundary.
    const decoder = new TextDecoder("utf-8");

    for (;;) {
      const chunk = await Promise.race([reader.read(), abortSignal]);
      if (chunk === null) break; // Aborted: the idle window or absolute cap won.
      if (chunk.done) break;
      armIdle();
      accumulator.feed(decoder.decode(chunk.value, { stream: true }));
      if (accumulator.settled()) {
        // The provider signalled its terminal event; stop reading promptly.
        void reader.cancel().catch(() => undefined);
        break;
      }
    }

    /**
     * A late abort must not discard a response that already reached its terminal
     * event: if the stream settled, `interpretStream` judges it on its own
     * content. Only an unsettled stream is reported as a stall/deadline.
     */
    if (abortReason && !accumulator.settled()) {
      const snapshot = accumulator.snapshot();
      void reader.cancel().catch(() => undefined);
      return abortFailure(snapshot);
    }

    /**
     * Order matters: the decoder is flushed FIRST so any characters completed by
     * the final bytes reach the accumulator, then the accumulator flushes a last
     * line that never received its newline.
     */
    const trailing = decoder.decode();
    if (trailing) accumulator.feed(trailing);
    accumulator.flush();
    const snapshot = accumulator.snapshot();

    const base: ChatCompletionMetadata = {
      status: response.status,
      requestedModel: model.id,
      model: snapshot.model ?? model.id,
      finishReason: snapshot.finishReason,
      usage: { ...snapshot.usage },
      providerRequestId: capturedRequestId ?? snapshot.responseId,
      retryAfterMs: capturedRetryAfterMs,
      errorCode: null,
      errorDetail: null,
    };

    return interpretStream(model, snapshot, base, apiKey);
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
    const message = error instanceof Error ? error.message : String(error);
    /**
     * An abort we initiated surfaces here as `AbortError`; it must be reported
     * as the stall/deadline it actually was, with the request id we captured.
     */
    if (abortReason || name === "AbortError" || name === "TimeoutError") {
      return abortFailure(null);
    }
    const timedOut = /timed? ?out|aborted/i.test(message);
    return failure({
      code: timedOut ? "TIMEOUT" : "NETWORK",
      retryable: true,
      error: timedOut
        ? "OpenRouter did not answer before the request deadline."
        : redactSecret(`OpenRouter request failed: ${message}`, apiKey),
      metadata: abortedMetadata(null, capturedStatus),
    });
  } finally {
    clearTimers();
  }
}

/**
 * Turn a finished stream into the shared result contract.
 *
 * Order matters: `length` and `content_filter` are reported with their specific
 * codes, and only then does the verdict reject a cancelled, incomplete or
 * unknown-reason stream. Partial text is never accepted as an answer.
 */
function interpretStream(
  model: AiModel,
  snapshot: StreamSnapshot,
  metadata: ChatCompletionMetadata,
  apiKey: string,
): ChatCompletionResult {
  const finishReason = snapshot.finishReason;

  if (finishReason === "length") {
    return failure({
      code: "OUTPUT_LIMIT",
      retryable: false,
      status: metadata.status ?? undefined,
      retryAfterMs: metadata.retryAfterMs,
      error:
        "OpenRouter stopped at the model's output limit before returning a complete answer. The incomplete response was discarded.",
      partialContent: persistablePartial(snapshot.content),
      metadata: { ...metadata, errorCode: "OUTPUT_LIMIT" },
    });
  }
  if (finishReason === "content_filter") {
    return failure({
      code: "CONTENT_FILTER",
      retryable: false,
      status: metadata.status ?? undefined,
      retryAfterMs: metadata.retryAfterMs,
      error: "OpenRouter blocked the response with its content filter. Nothing was saved.",
      metadata: { ...metadata, errorCode: "CONTENT_FILTER" },
    });
  }

  const verdict = streamCompletionVerdict(snapshot);
  if (!verdict.ok) {
    const code =
      verdict.reason === "tool_calls"
        ? "INVALID_REQUEST"
        : verdict.reason === "premature_eof"
          ? "TRANSIENT"
          : "PROVIDER_ERROR";
    return failure({
      code,
      retryable: verdict.reason === "premature_eof",
      status: metadata.status ?? undefined,
      retryAfterMs: metadata.retryAfterMs,
      error: redactSecret(verdict.detail ?? "The streamed response did not complete.", apiKey),
      partialContent:
        verdict.reason === "premature_eof"
          ? persistablePartial(snapshot.content)
          : undefined,
      metadata: { ...metadata, errorCode: code },
    });
  }

  if (!snapshot.content.trim()) {
    return failure({
      code: "EMPTY_COMPLETION",
      retryable: false,
      status: metadata.status ?? undefined,
      retryAfterMs: metadata.retryAfterMs,
      error: redactSecret(
        `OpenRouter returned an empty completion (finish reason "${finishReason ?? "none"}").`,
        apiKey,
      ),
      metadata: { ...metadata, errorCode: "EMPTY_COMPLETION" },
    });
  }

  return {
    ok: true,
    content: snapshot.content,
    model: snapshot.model ?? model.id,
    finishReason,
    truncated: false,
    metadata: { ...metadata, model: snapshot.model ?? model.id },
  };
}

/** The non-streaming fallback: a provider that ignored `stream: true`. */
function interpretJsonCompletion(
  model: AiModel,
  payload: unknown,
  response: Response,
  retryAfterMs: number | null,
  apiKey: string,
): ChatCompletionResult {
  const metadata = metadataFromPayload(
    model,
    payload,
    response.status,
    retryAfterMs,
    response.headers,
    OPENROUTER_REQUEST_ID_HEADERS,
  );

  // OpenRouter can answer 200 with an error envelope. Do not treat that as a
  // completion just because the HTTP status is green.
  const providerError = providerErrorDetail(payload);
  if (providerError) {
    return failure({
      code: "PROVIDER_ERROR",
      retryable: false,
      status: response.status,
      retryAfterMs,
      error: `OpenRouter reported an error: ${redactSecret(providerError, apiKey)}`,
      metadata,
    });
  }

  const finishReason = completionFinishReason(payload);
  metadata.finishReason = finishReason;

  if (finishReason === "length") {
    return failure({
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
    return failure({
      code: "CONTENT_FILTER",
      retryable: false,
      status: response.status,
      retryAfterMs,
      error: "OpenRouter blocked the response with its content filter. Nothing was saved.",
      metadata,
    });
  }
  if (finishReason === "error") {
    return failure({
      code: "PROVIDER_ERROR",
      retryable: false,
      status: response.status,
      retryAfterMs,
      error: `OpenRouter reported an error${providerError ? `: ${redactSecret(providerError, apiKey)}` : "."}`,
      metadata,
    });
  }
  // Same strictness as the streamed path: an unrecognised reason is not success.
  if (finishReason && finishReason !== "stop") {
    return failure({
      code: "PROVIDER_ERROR",
      retryable: false,
      status: response.status,
      retryAfterMs,
      error: `The provider finished with reason "${finishReason}", which is not a completed answer.`,
      metadata,
    });
  }

  const content = completionContent(payload);
  if (!content) {
    const detail = emptyCompletionDetail(payload);
    return failure({
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
}
