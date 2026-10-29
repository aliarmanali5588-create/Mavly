/**
 * OpenRouter model catalog and model resolution.
 *
 * ⚠️ SERVER-ONLY. This module reads `process.env`; never import it from a client
 * component. The browser only sees model ids the server chooses to expose.
 *
 * ═══ TEXT-GENERATION POLICY ════════════════════════════════════════════════
 *
 * Website and native Android source generation use OpenRouter. A browser,
 * generated application or untrusted project data can never name a credential
 * or model outside the verified catalog.
 */

export type AiTask = "app-generation" | "repair" | "review" | "fast" | "reasoning";

export type AiProviderId = "openrouter";

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
  /**
   * ⚠️ CONFIGURED IS NOT VERIFIED. `true` means this id has been confirmed
   * against the provider's own catalog by an operator. `false` means the id is
   * a product requirement that resolves and is sent verbatim, but its live
   * availability on this deployment's OpenRouter account is UNVERIFIED — a
   * rejection must surface as an exact role/model error, never a substitution.
   */
  verified: boolean;
}

/** The only supported text-generation provider. */
export const AI_PROVIDER_IDS: readonly AiProviderId[] = ["openrouter"];

/** The provider used for all text generation. */
export const DEFAULT_AI_PROVIDER: AiProviderId = "openrouter";

export const OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID = "deepseek/deepseek-v4.1-flash";
const OPENROUTER_DEFAULT_MODEL_ID = OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID;
export const COHERE_NORTH_MINI_CODE_MODEL_ID = "cohere/north-mini-code:free";
export const COHERE_NORTH_MINI_CODE_PROJECTS_ENV = "MAVLY_NORTH_MINI_CODE_PROJECTS";

/**
 * ═══ THE FINALIZED SPECIALIST IDS ═══════════════════════════════════════════
 *
 * These are locked product requirements for the multi-agent roles (see
 * `./model-roles.ts`). They are catalog entries so they resolve and are sent
 * exactly as written; they are marked `verified: false` until an operator has
 * confirmed them against the provider account, because this repository cannot
 * prove live availability without a paid request.
 */
export const OPENROUTER_DEEPSEEK_V4_PRO_MODEL_ID = "deepseek/deepseek-v4-pro";
export const OPENROUTER_CLAUDE_SONNET_5_MODEL_ID = "anthropic/claude-sonnet-5";
export const OPENROUTER_GPT_5_6_SOL_MODEL_ID = "openai/gpt-5.6-sol";

/**
 * The verified OpenRouter model ID. It is an OpenRouter ID (`vendor/model`);
 * provider-local aliases are never valid here because they would be sent
 * verbatim.
 */
export const OPENROUTER_MODEL_CATALOG: readonly AiModel[] = [
  {
    id: OPENROUTER_DEFAULT_MODEL_ID,
    label: "DeepSeek V4.1 Flash (OpenRouter)",
    provider: "openrouter",
    tasks: ["app-generation", "repair", "review", "fast", "reasoning"],
    maxOutputTokens: 24_000,
    verified: true,
  },
  {
    id: COHERE_NORTH_MINI_CODE_MODEL_ID,
    label: "Cohere: North Mini Code (free)",
    provider: "openrouter",
    tasks: ["app-generation", "repair", "review", "fast", "reasoning"],
    maxOutputTokens: 24_000,
    verified: true,
  },
  {
    id: OPENROUTER_DEEPSEEK_V4_PRO_MODEL_ID,
    label: "DeepSeek V4 Pro (OpenRouter)",
    provider: "openrouter",
    // Planner and Repair roles. No implicit default ever selects this model:
    // `resolveModel` only picks it when a caller names it explicitly.
    tasks: ["review", "reasoning", "repair"],
    maxOutputTokens: 24_000,
    verified: false,
  },
  {
    id: OPENROUTER_CLAUDE_SONNET_5_MODEL_ID,
    label: "Claude Sonnet 5 (OpenRouter)",
    provider: "openrouter",
    // Coding, UI/UX and Security roles.
    tasks: ["app-generation", "repair", "review", "reasoning"],
    maxOutputTokens: 32_000,
    verified: false,
  },
  {
    id: OPENROUTER_GPT_5_6_SOL_MODEL_ID,
    label: "GPT-5.6 Sol (OpenRouter)",
    provider: "openrouter",
    // QA role.
    tasks: ["review", "reasoning"],
    maxOutputTokens: 24_000,
    verified: false,
  },
];

/**
 * The supported text model catalog. Kept as a named export for callers and
 * tests that pin the configured model.
 */
export const AI_MODEL_CATALOG: readonly AiModel[] = OPENROUTER_MODEL_CATALOG;

/**
 * The experimental model is available only to projects named by the operator.
 * Empty and wildcard cohorts are refused; this is intentionally not a client
 * controlled feature flag.
 */
export function isCohereNorthMiniCodeEnabledForProject(
  projectId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const project = projectId?.trim().toLowerCase();
  const configured = (env[COHERE_NORTH_MINI_CODE_PROJECTS_ENV] ?? "").trim();
  if (!project || !configured || configured === "*") return false;

  const projects = configured
    .split(/[,;]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return !projects.includes("*") &&
    !projects.some((entry) => /\s/.test(entry)) &&
    projects.includes(project);
}

export function isModelEnabledForProject(
  modelId: string,
  projectId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!OPENROUTER_MODEL_CATALOG.some((model) => model.id === modelId)) return false;
  return modelId !== COHERE_NORTH_MINI_CODE_MODEL_ID ||
    isCohereNorthMiniCodeEnabledForProject(projectId, env);
}

/** `MAVLY_DEFAULT_MODEL` is an unvalidated override; resolution validates it. */
export function configuredDefaultModelId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MAVLY_DEFAULT_MODEL?.trim();
  return configured && configured !== COHERE_NORTH_MINI_CODE_MODEL_ID
    ? configured
    : OPENROUTER_DEFAULT_MODEL_ID;
}

/**
 * Pick the model for a task from the OpenRouter catalog. An explicit request
 * wins only when it names a catalog entry; otherwise the configured default is
 * used when it is itself an entry for the task, and the first suitable entry is
 * the last resort.
 */
export function resolveModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
  env: NodeJS.ProcessEnv = process.env,
  projectId?: string | null,
): AiModel {
  const requested = requestedModel?.trim();
  if (requested) {
    const exact = OPENROUTER_MODEL_CATALOG.find((model) => model.id === requested);
    if (exact && isModelEnabledForProject(exact.id, projectId, env)) return exact;
  }

  const defaultId = configuredDefaultModelId(env);
  const configured = OPENROUTER_MODEL_CATALOG.find((model) => model.id === defaultId);
  if (configured && configured.tasks.includes(task)) return configured;

  return OPENROUTER_MODEL_CATALOG.find((model) => model.tasks.includes(task)) ??
    OPENROUTER_MODEL_CATALOG[0];
}

/** Explicit OpenRouter resolver kept for callers that name the provider. */
export function resolveOpenRouterModel(
  requestedModel?: string | null,
  task: AiTask = "app-generation",
  env: NodeJS.ProcessEnv = process.env,
): AiModel {
  return resolveModel(requestedModel, task, env);
}
