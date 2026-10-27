/**
 * AI model catalog and routing.
 *
 * ⚠️ SERVER-ONLY. This module reads `process.env`; never import it from a client
 * component. The browser only sees model ids the server chooses to expose.
 *
 * Website and native Android source generation both use OpenRouter's
 * OpenAI-compatible chat-completions API. Keep model IDs limited to models
 * verified for that API: this catalog is the allowlist the adapter enforces
 * before a request leaves the server.
 */

export type AiTask = "app-generation" | "repair" | "review" | "fast" | "reasoning";

export interface AiModel {
  /** Provider model ID, exactly as sent on the wire. */
  id: string;
  label: string;
  /** Tasks this model is a sensible candidate for. */
  tasks: readonly AiTask[];
  /** Upper bound for generated project JSON. */
  maxOutputTokens: number;
}

/**
 * The verified OpenRouter model ID. This is OpenRouter's DeepSeek V4.1 Flash
 * endpoint and the repository's designated OpenRouter default.
 *
 * ⚠️ It is an OpenRouter ID (`vendor/model`). Provider-local aliases — including
 * the retired provider-local `claude-opus-*` names — are never valid here: they
 * would be sent verbatim and rejected upstream.
 */
const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";

/**
 * The active generation catalog. It contains only verified IDs so `resolveModel`
 * can never silently route a project to an unverified or unrelated model.
 */
export const AI_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "DeepSeek V4.1 Flash (OpenRouter)",
    tasks: ["app-generation", "repair", "review", "fast", "reasoning"],
    maxOutputTokens: 24_000,
  },
];

/**
 * The active catalog *is* the OpenRouter catalog: text generation has exactly one
 * provider. Kept as a named export for callers that resolve explicitly.
 */
export const OPENROUTER_MODEL_CATALOG: readonly AiModel[] = AI_MODEL_CATALOG;

export function configuredDefaultModelId(): string {
  const override = process.env.MAVLY_DEFAULT_MODEL?.trim();
  return override || DEFAULT_MODEL_ID;
}

/**
 * Pick the model for a task. An explicit request wins when it names a catalog
 * model; otherwise the configured default is used when it is itself a catalog
 * entry for the task, and the first suitable catalog entry is the last resort.
 *
 * A configured or requested value that is not in the catalog never reaches the
 * wire: it resolves to a verified entry instead.
 */
export function resolveModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
): AiModel {
  const requested = requestedModel?.trim();
  if (requested) {
    const exact = AI_MODEL_CATALOG.find((model) => model.id === requested);
    if (exact) return exact;
  }

  const defaultId = configuredDefaultModelId();
  const configured = AI_MODEL_CATALOG.find((model) => model.id === defaultId);
  if (configured && configured.tasks.includes(task)) return configured;

  return AI_MODEL_CATALOG.find((model) => model.tasks.includes(task)) ?? AI_MODEL_CATALOG[0];
}

/**
 * Explicit OpenRouter resolution. The active catalog is the OpenRouter catalog,
 * so this is the same policy as `resolveModel`; it stays a named export for
 * callers that name the provider on purpose.
 */
export function resolveOpenRouterModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
): AiModel {
  return resolveModel(requestedModel, task);
}

export function modelCatalogIds(): string[] {
  return AI_MODEL_CATALOG.map((model) => model.id);
}
