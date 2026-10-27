/**
 * Server-side OpenRouter boundary for website and Android source generation.
 * The pipeline uses this module for the chat contract, configuration checks
 * and completion calls; all text generation uses OpenRouter.
 */

import * as openrouterProvider from "./openrouter";
import type { AiModel } from "./models";
import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatMessage,
} from "./chat-contract";

export { isChatCompletionFailure } from "./chat-contract";
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

/** Whether the sole supported text provider is configured. */
export function isAiConfigured(): boolean {
  return openrouterProvider.isAiConfigured();
}

/** The actionable, secret-free configuration error for text generation. */
export function generationConfigurationError(): string {
  return "OpenRouter is not configured. Add OPENROUTER_API_KEY to the server runtime.";
}

/** One completion from OpenRouter; the adapter enforces its model catalog. */
export async function chatCompletion(
  model: AiModel,
  messages: ChatMessage[],
  options: number | ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  return openrouterProvider.chatCompletion(model, messages, options);
}
