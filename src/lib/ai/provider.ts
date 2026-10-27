/**
 * Active website/Android source-generation provider boundary.
 *
 * Business logic depends on this provider-neutral surface (website generation,
 * native Android source generation, the durable worker and bounded verification
 * repair all call `chatCompletion`). This module is the ONLY place that decides
 * which provider serves a request.
 *
 * ═══ SELECTION RULES ════════════════════════════════════════════════════════
 *
 *   · The provider is chosen from server-side configuration
 *     (`MAVLY_AI_PROVIDER`) in `./models.ts`. The browser cannot influence it.
 *   · OpenRouter is the default and stays the default. Token Harbor is used
 *     only when an operator explicitly selects it.
 *   · There is NO automatic provider fallback. If the selected provider fails,
 *     the failure is reported as that provider's failure — a silent switch would
 *     hide a real provider error, change the shipped model and make reported
 *     cost/usage describe a request Mavly did not intend to make.
 *   · Each adapter re-checks its own model catalog before any network call, so a
 *     model id can never cross providers.
 */

import * as openrouterProvider from "./openrouter";
import * as tokenHarborProvider from "./tokenharbor";
import { activeAiProvider, type AiProviderId } from "./models";
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

/** Display labels. Used in operator-facing configuration errors only. */
export const TEXT_PROVIDER_LABELS: Readonly<Record<AiProviderId, string>> = {
  openrouter: "OpenRouter",
  tokenharbor: "Token Harbor",
};

/** The server-only variable each provider reads. Never a `NEXT_PUBLIC_` name. */
export const TEXT_PROVIDER_API_KEY_NAMES: Readonly<Record<AiProviderId, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  tokenharbor: "TOKEN_HARBOR_API_KEY",
};

export function activeTextProvider(env: NodeJS.ProcessEnv = process.env): AiProviderId {
  return activeAiProvider(env);
}

export function textProviderLabel(provider: AiProviderId = activeAiProvider()): string {
  return TEXT_PROVIDER_LABELS[provider];
}

export function textProviderApiKeyName(provider: AiProviderId = activeAiProvider()): string {
  return TEXT_PROVIDER_API_KEY_NAMES[provider];
}

/**
 * Whether the SELECTED provider is configured. Callers use this to fail closed
 * with `503 BACKEND_NOT_CONFIGURED` before admitting any work.
 */
export function isAiConfigured(provider: AiProviderId = activeAiProvider()): boolean {
  return provider === "tokenharbor"
    ? tokenHarborProvider.isAiConfigured()
    : openrouterProvider.isAiConfigured();
}

/**
 * The actionable, secret-free configuration error for the selected provider.
 * It names the provider and the exact server-side variable to set — never a
 * value, never a key fragment.
 */
export function generationConfigurationError(provider: AiProviderId = activeAiProvider()): string {
  return `${textProviderLabel(provider)} is not configured. Add ${textProviderApiKeyName(provider)} to the server runtime.`;
}

/**
 * One completion from the selected provider. The model must already have been
 * resolved through `./models.ts`, and the adapter rejects an id belonging to a
 * different provider.
 */
export async function chatCompletion(
  model: AiModel,
  messages: ChatMessage[],
  options: number | ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  return activeAiProvider() === "tokenharbor"
    ? tokenHarborProvider.chatCompletion(model, messages, options)
    : openrouterProvider.chatCompletion(model, messages, options);
}
