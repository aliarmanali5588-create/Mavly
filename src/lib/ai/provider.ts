/**
 * Active website/Android source-generation provider boundary.
 *
 * Business logic depends on this provider-neutral surface; select a different
 * adapter here only when the active generation provider changes. OpenRouter is
 * the only text-generation provider: the same module serves website and native
 * Android source generation, the durable worker and bounded verification repair.
 */
export {
  chatCompletion,
  isAiConfigured,
  isChatCompletionFailure,
} from "./openrouter";
export type {
  ChatCompletionErrorCode,
  ChatCompletionFailure,
  ChatCompletionMetadata,
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatCompletionSuccess,
  ChatCompletionUsage,
  ChatMessage,
} from "./openrouter";
