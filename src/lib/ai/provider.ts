/**
 * Active website-generation provider boundary.
 *
 * Business logic depends on this provider-neutral surface; select a different
 * adapter here only when the active website-generation provider changes.
 */
export {
  chatCompletion,
  isAiConfigured,
  isChatCompletionFailure,
} from "./freemodel";
export type {
  ChatCompletionErrorCode,
  ChatCompletionFailure,
  ChatCompletionMetadata,
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatCompletionSuccess,
  ChatCompletionUsage,
  ChatMessage,
} from "./freemodel";
