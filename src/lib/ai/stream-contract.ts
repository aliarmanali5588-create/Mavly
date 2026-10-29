/**
 * ═══ STREAMED COMPLETIONS — ACCUMULATION AND COMPLETION RULES ════════════════
 *
 * A non-streaming request has one deadline for the WHOLE response, so a large
 * but healthy generation is aborted purely because it is slow. Streaming lets
 * the transport watch for *progress* instead of total duration:
 *
 *   · a chunk arriving is progress, whatever the request's age;
 *   · silence for longer than the idle window is a stall;
 *   · a hard absolute cap still bounds a pathological stream.
 *
 * This module owns the parsing half of that contract. It is PURE: no fetch, no
 * env, no clock. The transport feeds it decoded text and decides when to abort;
 * the agent consumes the finalized snapshot.
 *
 * ⚠️ PARTIAL TEXT IS NOT A RESULT. A stream that ends without a recognised
 * completion — a premature EOF, a provider `error` event, a `cancelled` finish
 * reason, an unknown finish reason — is a FAILURE even when text was received.
 * Accumulating bytes and hoping they parse is how half a file reaches a user.
 */

import type { ChatCompletionUsage } from "./chat-contract";
import { EMPTY_USAGE, completionUsage } from "./chat-contract";

/** Why a stream did not produce a usable completion. */
export type StreamFailureReason =
  | "provider_error"
  | "cancelled"
  | "unknown_finish_reason"
  | "premature_eof"
  | "tool_calls"
  | "malformed_chunk";

/** A finish reason that means "the model finished normally". */
const SUCCESS_FINISH_REASONS = new Set(["stop", "end_turn", "eos", "stop_sequence"]);

export interface StreamSnapshot {
  /** Every delta's text, in order. Empty when nothing was produced. */
  content: string;
  finishReason: string | null;
  model: string | null;
  /** Payload `id`, kept so a failed body can still be reconciled upstream. */
  responseId: string | null;
  /** Usage reported by any chunk (normally the final one). Never estimated. */
  usage: ChatCompletionUsage;
  chunkCount: number;
  /** True when the provider sent its terminal `[DONE]` marker. */
  sawDone: boolean;
  /** Set when the provider sent an in-stream error event. */
  errorDetail: string | null;
}

export interface StreamCompletionVerdict {
  ok: boolean;
  reason: StreamFailureReason | null;
  /** A user-safe explanation; never echoes provider payload beyond a bound. */
  detail: string | null;
}

export interface StreamAccumulator {
  /** Feed one decoded slice of the event stream. Partial lines are buffered. */
  feed(text: string): void;
  /** Flush a trailing line that never received its newline. */
  flush(): void;
  /** The accumulated state, safe to call at any time (including mid-stream). */
  snapshot(): StreamSnapshot;
  /** Whether the provider signalled a terminal event. */
  settled(): boolean;
}

function emptySnapshot(): StreamSnapshot {
  return {
    content: "",
    finishReason: null,
    model: null,
    responseId: null,
    usage: EMPTY_USAGE,
    chunkCount: 0,
    sawDone: false,
    errorDetail: null,
  };
}

/**
 * One SSE event's `data:` payload. Multi-line `data:` fields are joined the way
 * the SSE specification requires; comment (`:`) and other fields are ignored.
 */
export function parseSseEvent(raw: string): string | null {
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (!trimmed.startsWith("data:")) continue;
    dataLines.push(trimmed.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

function deltaText(delta: unknown): string {
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const value = (part as { text?: unknown }).text;
    if (typeof value === "string") text += value;
  }
  return text;
}

function errorDetailOf(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 300);
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim().slice(0, 120);
  }
  return null;
}

/**
 * Count occurrences of a key in a chunk's usage so a later chunk can replace it
 * without losing the earlier value when the provider reports usage only once.
 */
function mergeUsage(
  current: ChatCompletionUsage,
  payload: Record<string, unknown>,
): ChatCompletionUsage {
  if (!payload.usage || typeof payload.usage !== "object") return current;
  const next = completionUsage(payload);
  return {
    promptTokens: next.promptTokens ?? current.promptTokens,
    completionTokens: next.completionTokens ?? current.completionTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
    cachedReadTokens: next.cachedReadTokens ?? current.cachedReadTokens,
    cachedWriteTokens: next.cachedWriteTokens ?? current.cachedWriteTokens,
    costUsd: next.costUsd ?? current.costUsd,
  };
}

export function createStreamAccumulator(): StreamAccumulator {
  let state = emptySnapshot();
  let buffer = "";
  let done = false;

  const consumeLine = (line: string): void => {
    if (done) return;
    const data = parseSseEvent(line);
    if (!data) return;

    if (data.trim() === "[DONE]") {
      state.sawDone = true;
      done = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      // A malformed chunk invalidates the completion: we cannot know whether it
      // carried content or a finish reason.
      state.errorDetail = state.errorDetail ?? "The provider sent a malformed stream chunk.";
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      state.errorDetail = state.errorDetail ?? "The provider sent a malformed stream chunk.";
      return;
    }

    const record = payload as Record<string, unknown>;
    state.chunkCount += 1;

    if (typeof record.id === "string" && record.id.trim() && !state.responseId) {
      state.responseId = record.id.trim().slice(0, 200);
    }
    if (typeof record.model === "string" && record.model.trim()) {
      state.model = record.model.trim();
    }
    state.usage = mergeUsage(state.usage, record);

    const errorDetail = errorDetailOf(record);
    if (errorDetail) {
      state.errorDetail = errorDetail;
      return;
    }

    const choices = record.choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const first = choices[0];
    if (!first || typeof first !== "object") return;
    const choice = first as Record<string, unknown>;

    const finish = choice.finish_reason;
    if (typeof finish === "string" && finish.trim()) {
      state.finishReason = finish.trim();
    }

    const delta = choice.delta ?? choice.message;
    const text = deltaText(delta);
    if (text) state.content += text;
  };

  const drain = (final: boolean): void => {
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      // A blank line terminates an event; we parse per line, which is
      // equivalent for OpenAI-compatible streams (one JSON object per line).
      if (line.trim()) consumeLine(line);
      index = buffer.indexOf("\n");
    }
    if (final && buffer.trim()) {
      consumeLine(buffer);
      buffer = "";
    }
  };

  return {
    feed(text: string): void {
      if (!text) return;
      buffer += text;
      drain(false);
    },
    flush(): void {
      drain(true);
    },
    snapshot(): StreamSnapshot {
      return { ...state, usage: { ...state.usage } };
    },
    settled(): boolean {
      return done || state.errorDetail !== null;
    },
  };
}

/**
 * Decide whether a finished stream is a usable completion.
 *
 * ⚠️ THE RULE IS DELIBERATELY STRICT. `stop` is success; `[DONE]` without a
 * finish reason is accepted (some providers omit it); everything else is a
 * typed failure so the caller can shrink scope or fail honestly instead of
 * persisting half a document.
 */
export function streamCompletionVerdict(snapshot: StreamSnapshot): StreamCompletionVerdict {
  if (snapshot.errorDetail) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `The provider reported an error mid-stream: ${snapshot.errorDetail}`,
    };
  }

  const finish = snapshot.finishReason;

  if (finish === "tool_calls") {
    return {
      ok: false,
      reason: "tool_calls",
      detail: "The model returned tool calls instead of text, which Mavly does not support.",
    };
  }
  if (finish === "cancelled" || finish === "canceled") {
    return {
      ok: false,
      reason: "cancelled",
      detail: "The provider reported the response as cancelled before it completed.",
    };
  }
  if (finish && !SUCCESS_FINISH_REASONS.has(finish)) {
    return {
      ok: false,
      reason: "unknown_finish_reason",
      detail: `The provider finished with reason "${finish}", which is not a completed answer.`,
    };
  }
  if (!finish && !snapshot.sawDone) {
    return {
      ok: false,
      reason: "premature_eof",
      detail: "The response stream ended before the provider signalled completion.",
    };
  }

  return { ok: true, reason: null, detail: null };
}
