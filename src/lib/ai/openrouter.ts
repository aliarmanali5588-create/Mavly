/**
 * OpenRouter chat-completions client.
 *
 * ⚠️ SERVER-ONLY. `OPENROUTER_API_KEY` never leaves this module; it is not a
 * `NEXT_PUBLIC_` variable and must never be returned in an API response or log.
 */

import type { AiModel } from "./models";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatCompletionFailure = { ok: false; error: string; status?: number };

export type ChatCompletionResult =
  | { ok: true; content: string; model: string }
  | ChatCompletionFailure;

export function isChatCompletionFailure(
  result: ChatCompletionResult,
): result is ChatCompletionFailure {
  return result.ok === false;
}

export function isAiConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim();
}

/**
 * One completion. The timeout matches the route's `maxDuration`; a provider
 * that hangs must not leave a run stuck in `init` forever.
 */
export async function chatCompletion(
  model: AiModel,
  messages: ChatMessage[],
  timeoutMs = 240_000,
): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "OPENROUTER_API_KEY is not configured." };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "Mavly",
  };
  if (appUrl) headers["HTTP-Referer"] = appUrl;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.id,
        messages,
        temperature: 0.2,
        max_tokens: model.maxOutputTokens,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Keep the status; the body may be plain text from a proxy.
    }

    if (!response.ok) {
      const detail = providerErrorDetail(payload) || text.slice(0, 500);
      return {
        ok: false,
        error: `OpenRouter request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        status: response.status,
      };
    }

    const finishReason = completionFinishReason(payload);
    if (finishReason === "length") {
      return {
        ok: false,
        error:
          "OpenRouter stopped at the model's output limit before returning a complete answer. Nothing was saved. Try a simpler request or choose a model with a larger output limit.",
      };
    }
    if (finishReason === "content_filter") {
      return {
        ok: false,
        error: "OpenRouter blocked the response with its content filter. Nothing was saved.",
      };
    }
    if (finishReason === "error") {
      const detail = providerErrorDetail(payload);
      return {
        ok: false,
        error: `OpenRouter reported an error${detail ? `: ${detail}` : "."}`,
      };
    }

    const content = completionContent(payload);
    if (!content) {
      const detail = emptyCompletionDetail(payload);
      return {
        ok: false,
        error: `OpenRouter returned an empty completion.${detail ? ` ${detail}` : ""}`,
      };
    }

    return {
      ok: true,
      content,
      model: completionModel(payload) || model.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `OpenRouter request failed: ${message}` };
  }
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

function completionContent(payload: unknown): string | null {
  const message = completionMessage(payload);
  if (message) {
    const content = contentText(message.content);
    if (content) return content;
  }
  const first = firstChoice(payload);
  return first ? contentText(first.text) : null;
}

function completionFinishReason(payload: unknown): string | null {
  const first = firstChoice(payload);
  const reason = first?.finish_reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
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

function completionModel(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const model = (payload as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function providerErrorDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
