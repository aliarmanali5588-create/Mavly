/**
 * AI model catalog and routing.
 *
 * ⚠️ SERVER-ONLY. This module reads `process.env`; never import it from a client
 * component. The browser only sees model ids the server chooses to expose.
 *
 * The active agent uses `deepseek/deepseek-v4.1-flash` through OpenRouter. The
 * other entries are wired for future task-based routing: add a model here, then
 * select it by task or by an explicit client request. No other code should
 * hardcode a provider slug.
 */

export type AiTask = "app-generation" | "repair" | "review" | "fast" | "reasoning";

export interface AiModel {
  /** OpenRouter model slug, exactly as sent on the wire. */
  id: string;
  label: string;
  /** Tasks this model is a sensible candidate for. */
  tasks: readonly AiTask[];
  /** Upper bound for generated project JSON. */
  maxOutputTokens: number;
}

const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";

/**
 * Five models are registered now so routing is a selection problem later, not a
 * wiring problem. Only the default is used until routing is enabled.
 *
 * ⚠️ VERIFY A SLUG IN OPENROUTER'S MODEL LIST BEFORE ENABLING IT. An unknown
 * slug fails at request time; it is not a fallback.
 */
export const AI_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "DeepSeek V4.1 Flash",
    tasks: ["app-generation", "repair", "fast"],
    maxOutputTokens: 24_000,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    tasks: ["app-generation", "repair", "review"],
    maxOutputTokens: 24_000,
  },
  {
    id: "openai/gpt-5.1",
    label: "GPT-5.1",
    tasks: ["app-generation", "reasoning", "review"],
    maxOutputTokens: 24_000,
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    tasks: ["review", "fast"],
    maxOutputTokens: 24_000,
  },
  {
    id: "qwen/qwen3-coder",
    label: "Qwen3 Coder",
    tasks: ["app-generation", "repair"],
    maxOutputTokens: 24_000,
  },
];

export function configuredDefaultModelId(): string {
  const override = process.env.MAVLY_DEFAULT_MODEL?.trim();
  return override || DEFAULT_MODEL_ID;
}

/**
 * Pick the model for a task. An explicit request wins when it names a catalog
 * model; otherwise the first catalog entry that supports the task is used.
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

export function modelCatalogIds(): string[] {
  return AI_MODEL_CATALOG.map((model) => model.id);
}
