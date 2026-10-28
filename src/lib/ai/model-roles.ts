/**
 * ═══ ROLE-SPECIFIC MODEL RESOLUTION ═════════════════════════════════════════
 *
 * Six of the seven orchestration roles may make model calls; deployment is a
 * deterministic workflow and never does.
 *
 *   planner      advisory plan
 *   ui_ux        advisory design review
 *   coding       the existing generation engine
 *   qa           advisory source review, after the verification sandbox result
 *   security     advisory review; the deterministic scan remains the gate
 *   repair       bounded diagnosis; suggestions re-enter through the coding engine
 *   deployment   deterministic, model-free
 *
 * The role-to-model assignments are fixed and have no environment override.
 * Missing or disabled entries are unavailable; callers must not fall back to
 * the requested project model or the global default.
 * Until the requested specialist IDs are verified, each model role is pinned
 * explicitly to the verified DeepSeek V4.1 Flash catalog entry.
 *
 * A role whose model is unavailable returns `null`; the caller records that
 * role as failed instead of silently substituting a different model.
 *
 * SERVER-ONLY: resolves through the server model catalog. Never import from a
 * client component.
 */

import {
  OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
  OPENROUTER_MODEL_CATALOG,
  isModelEnabledForProject,
  type AiModel,
  type AiTask,
} from "./models";

export const AGENT_MODEL_ROLES = [
  "planner",
  "ui_ux",
  "coding",
  "qa",
  "security",
  "repair",
  "deployment",
] as const;

export type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number];

export type RoleModelKind = "model" | "deterministic";

export interface RoleModelDefinition {
  role: AgentModelRole;
  kind: RoleModelKind;
  modelId: string | null;
  task: AiTask | null;
  deterministicReason: string | null;
}

export const ROLE_MODEL_DEFINITIONS: readonly RoleModelDefinition[] = [
  {
    role: "planner",
    kind: "model",
    modelId: OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
    task: "review",
    deterministicReason: null,
  },
  {
    role: "ui_ux",
    kind: "model",
    modelId: OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
    task: "review",
    deterministicReason: null,
  },
  {
    role: "coding",
    kind: "model",
    modelId: OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
    task: "app-generation",
    deterministicReason: null,
  },
  {
    role: "qa",
    kind: "model",
    modelId: OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
    task: "review",
    deterministicReason: null,
  },
  {
    role: "security",
    kind: "model",
    modelId: OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
    task: "review",
    deterministicReason: null,
  },
  {
    role: "repair",
    kind: "model",
    modelId: OPENROUTER_DEEPSEEK_V4_1_FLASH_MODEL_ID,
    task: "repair",
    deterministicReason: null,
  },
  {
    role: "deployment",
    kind: "deterministic",
    modelId: null,
    task: null,
    deterministicReason:
      "Deployment is a deterministic workflow; only the owner's artifact-bound approval can authorize it.",
  },
];

export function roleModelDefinition(role: AgentModelRole): RoleModelDefinition {
  const definition = ROLE_MODEL_DEFINITIONS.find((entry) => entry.role === role);
  if (!definition) throw new Error(`Missing model-routing definition for role "${role}".`);
  return definition;
}

/**
 * Resolve exactly the model pinned to a role. Returns null for deterministic
 * roles or when the pinned model is absent/disabled.
 */
export function resolveRoleModel(input: {
  role: AgentModelRole;
  env?: NodeJS.ProcessEnv;
  projectId?: string | null;
}): AiModel | null {
  const env = input.env ?? process.env;
  const definition = roleModelDefinition(input.role);
  const task = definition.task;
  if (definition.kind === "deterministic" || !definition.modelId || !task) {
    return null;
  }
  const model = OPENROUTER_MODEL_CATALOG.find(
    (entry) => entry.id === definition.modelId && entry.tasks.includes(task),
  );
  if (!model || !isModelEnabledForProject(model.id, input.projectId, env)) return null;
  return model;
}

export interface RoleModelStatus {
  role: AgentModelRole;
  kind: RoleModelKind;
  /** The pinned id, even when unavailable in the catalog. */
  configured: string | null;
  /** What the role will actually use, or null for a deterministic role. */
  resolved: string | null;
  accepted: boolean;
  note: string | null;
}

/**
 * Diagnostics for operators. This reveals model ids only — never a key — and is
 * safe for an internal status response.
 */
export function roleModelStatus(
  env: NodeJS.ProcessEnv = process.env,
  projectId?: string | null,
): RoleModelStatus[] {
  return ROLE_MODEL_DEFINITIONS.map((definition) => {
    const resolved = resolveRoleModel({ role: definition.role, env, projectId });
    const accepted = definition.kind === "deterministic" || resolved !== null;
    return {
      role: definition.role,
      kind: definition.kind,
      configured: definition.modelId,
      resolved: resolved?.id ?? null,
      accepted,
      note:
        definition.kind === "deterministic"
          ? definition.deterministicReason
          : accepted
            ? null
            : `The pinned model "${definition.modelId}" is not available in the enabled catalog.`,
    };
  });
}
