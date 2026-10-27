/**
 * AI model catalog, provider selection and routing.
 *
 * ⚠️ SERVER-ONLY. This module reads `process.env`; never import it from a client
 * component. The browser only sees model ids the server chooses to expose.
 *
 * ═══ PROVIDER POLICY ════════════════════════════════════════════════════════
 *
 * Website and native Android source generation both use an OpenAI-compatible
 * chat-completions provider. Two are supported:
 *
 *   · `openrouter`  — the default, unchanged production provider;
 *   · `tokenharbor` — an additional provider, selected ONLY by explicit
 *     server-side configuration (`MAVLY_AI_PROVIDER`). It is never selected
 *     automatically, and an unrecognized value falls back to the default rather
 *     than enabling something new.
 *
 * The provider is chosen here, on the server. A browser, a generated application
 * or any untrusted project data can never name a provider, a credential or a
 * model outside these catalogs.
 *
 * ⚠️ MODEL IDS ARE PROVIDER-SCOPED AND NOT INTERCHANGEABLE. OpenRouter ids are
 * `vendor/model` (`deepseek/deepseek-v4.1-flash`); Token Harbor ids are
 * provider-local (`deepseek-v4.1-flash:free`). Sending one to the other fails,
 * so resolution and the adapters' catalog gates both work per provider.
 */

export type AiTask = "app-generation" | "repair" | "review" | "fast" | "reasoning";

export type AiProviderId = "openrouter" | "tokenharbor";

export interface AiModel {
  /** Provider model ID, exactly as sent on the wire. */
  id: string;
  label: string;
  /** The provider that serves this id. An id is valid for that provider only. */
  provider: AiProviderId;
  /** Tasks this model is a sensible candidate for. */
  tasks: readonly AiTask[];
  /** Upper bound for generated project JSON. */
  maxOutputTokens: number;
}

/** Every supported provider, in preference order. */
export const AI_PROVIDER_IDS: readonly AiProviderId[] = ["openrouter", "tokenharbor"];

/** The provider used when nothing explicitly selects one. */
export const DEFAULT_AI_PROVIDER: AiProviderId = "openrouter";

/** Server-only variable that selects the text-generation provider. */
export const AI_PROVIDER_ENV_KEY = "MAVLY_AI_PROVIDER";

const OPENROUTER_DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";
const TOKEN_HARBOR_DEFAULT_MODEL_ID = "deepseek-v4.1-flash:free";

/**
 * The verified OpenRouter model ID. It is an OpenRouter ID (`vendor/model`);
 * provider-local aliases — including the retired FreeModel `claude-opus-*`
 * names — are never valid here because they would be sent verbatim.
 */
export const OPENROUTER_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: OPENROUTER_DEFAULT_MODEL_ID,
    label: "DeepSeek V4.1 Flash (OpenRouter)",
    provider: "openrouter",
    tasks: ["app-generation", "repair", "review", "fast", "reasoning"],
    maxOutputTokens: 24_000,
  },
];

/**
 * The verified Token Harbor model ID. Token Harbor ids are provider-local, so
 * the OpenRouter-style `deepseek/deepseek-v4.1-flash` must never be used here.
 * The `:free` route is rate-limited by the provider rather than billed per
 * request; that limit is the provider's to enforce, and Mavly does not pretend
 * to know or raise it.
 */
export const TOKEN_HARBOR_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: TOKEN_HARBOR_DEFAULT_MODEL_ID,
    label: "DeepSeek V4.1 Flash:free (Token Harbor)",
    provider: "tokenharbor",
    tasks: ["app-generation", "repair", "review", "fast", "reasoning"],
    maxOutputTokens: 24_000,
  },
];

/** Every catalog, keyed by the provider that serves it. */
export const TEXT_MODEL_CATALOGS: Readonly<Record<AiProviderId, readonly AiModel[]>> = {
  openrouter: OPENROUTER_MODEL_CATALOG,
  tokenharbor: TOKEN_HARBOR_MODEL_CATALOG,
};

/**
 * The default provider's catalog (OpenRouter). Kept as a named export for
 * callers and tests that pin the default; use `activeModelCatalog()` when the
 * selected provider matters.
 */
export const AI_MODEL_CATALOG: readonly AiModel[] = OPENROUTER_MODEL_CATALOG;

/** `null` when the value is not a supported provider. Never guesses. */
export function normalizeAiProviderId(value: string | null | undefined): AiProviderId | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const compact = raw.replace(/[-_\s]/g, "");
  if (compact === "openrouter") return "openrouter";
  if (compact === "tokenharbor") return "tokenharbor";
  return null;
}

/**
 * The selected provider. An unset or unrecognized value keeps the default, so a
 * typo can never silently route generation somewhere new.
 */
export function activeAiProvider(env: NodeJS.ProcessEnv = process.env): AiProviderId {
  return normalizeAiProviderId(env[AI_PROVIDER_ENV_KEY]) ?? DEFAULT_AI_PROVIDER;
}

export function modelCatalogFor(provider: AiProviderId): readonly AiModel[] {
  return TEXT_MODEL_CATALOGS[provider];
}

export function activeModelCatalog(env: NodeJS.ProcessEnv = process.env): readonly AiModel[] {
  return modelCatalogFor(activeAiProvider(env));
}

/** `MAVLY_DEFAULT_MODEL` is an unvalidated override; resolution validates it. */
export function configuredDefaultModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAVLY_DEFAULT_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL_ID;
}

/**
 * Pick the model for a task from ONE provider's catalog. An explicit request
 * wins only when it names a catalog entry; otherwise the configured default is
 * used when it is itself an entry for the task, and the first suitable entry is
 * the last resort. A requested value from another provider is never forwarded.
 */
export function resolveModelForProvider(
  provider: AiProviderId,
  requestedModel?: string | null,
  task: AiTask = "app-generation",
  env: NodeJS.ProcessEnv = process.env,
): AiModel {
  const catalog = modelCatalogFor(provider);

  const requested = requestedModel?.trim();
  if (requested) {
    const exact = catalog.find((model) => model.id === requested);
    if (exact) return exact;
  }

  const defaultId = configuredDefaultModelId(env);
  const configured = catalog.find((model) => model.id === defaultId);
  if (configured && configured.tasks.includes(task)) return configured;

  return catalog.find((model) => model.tasks.includes(task)) ?? catalog[0];
}

/** The model the active provider serves for this task. */
export function resolveModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
  env: NodeJS.ProcessEnv = process.env,
): AiModel {
  return resolveModelForProvider(activeAiProvider(env), requestedModel, task, env);
}

/** Explicit OpenRouter resolution, regardless of the selected provider. */
export function resolveOpenRouterModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
  env: NodeJS.ProcessEnv = process.env,
): AiModel {
  return resolveModelForProvider("openrouter", requestedModel, task, env);
}

/** Explicit Token Harbor resolution, regardless of the selected provider. */
export function resolveTokenHarborModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
  env: NodeJS.ProcessEnv = process.env,
): AiModel {
  return resolveModelForProvider("tokenharbor", requestedModel, task, env);
}

export function modelCatalogIds(provider: AiProviderId = activeAiProvider()): string[] {
  return modelCatalogFor(provider).map((model) => model.id);
}
