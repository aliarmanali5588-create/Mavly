/**
 * AI model catalog and routing.
 *
 * ⚠️ SERVER-ONLY. This module reads `process.env`; never import it from a client
 * component. The browser only sees model ids the server chooses to expose.
 *
 * Website generation uses the FreeModel-hosted catalog below. Keep model IDs
 * limited to models verified for the OpenAI-compatible FreeModel API.
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

const DEFAULT_MODEL_ID = "claude-opus-4.8";

export const AI_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Claude Opus 4.8 (FreeModel)",
    tasks: ["app-generation", "repair", "review", "fast", "reasoning"],
    maxOutputTokens: 24_000,
  },
];

const OPENROUTER_DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";

/**
 * Preserve the previous OpenRouter model catalog for explicitly reactivated
 * OpenRouter workflows. The active website-generation resolver below uses only
 * the FreeModel catalog; these entries are never sent by the current run-agent path.
 * Revalidate these historical model IDs against OpenRouter before reactivation.
 */
export const OPENROUTER_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: OPENROUTER_DEFAULT_MODEL_ID,
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

export function resolveOpenRouterModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
): AiModel {
  const requested = requestedModel?.trim();
  if (requested) {
    const exact = OPENROUTER_MODEL_CATALOG.find((model) => model.id === requested);
    if (exact) return exact;
  }
  return (
    OPENROUTER_MODEL_CATALOG.find(
      (model) => model.id === OPENROUTER_DEFAULT_MODEL_ID && model.tasks.includes(task),
    ) ??
    OPENROUTER_MODEL_CATALOG.find((model) => model.tasks.includes(task)) ??
    OPENROUTER_MODEL_CATALOG[0]
  );
}

export function modelCatalogIds(): string[] {
  return AI_MODEL_CATALOG.map((model) => model.id);
}
