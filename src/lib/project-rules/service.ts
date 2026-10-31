/**
 * ═══ PERSISTED PROJECT RULES — SERVER SERVICE ═══════════════════════════════
 *
 * Storage is `project_files`, the same table the source explorer already reads,
 * so no migration and no second source of truth are needed. Every call uses the
 * caller's RLS-scoped client (or the worker's confined client), never a new
 * privileged path.
 *
 * `ensure` is idempotent. It creates both files without replacing existing
 * work-state content, refreshes the server-authored rules when needed, and
 * reads both rows back before allowing planning.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  insertFilesIfMissing,
  isStoreFailure,
  listFiles,
  writeFiles,
} from "@/lib/mavly/store";
import {
  AGENT_RULES_CONTENT,
  AGENT_RULES_PATH,
  AGENT_WORK_PATH,
} from "./rules";
import { ensureSelectionRule, findGlobalStylesheet, hasSelectionRule } from "./selection";
import {
  buildWorkLogEntry,
  initialWorkStateContent,
  mergeWorkState,
  type WorkLogInput,
} from "./work-state";

export interface ProjectRuleFiles {
  rules: string;
  workState: string;
}

export type ProjectRuleFilesResult =
  | { ok: true; files: ProjectRuleFiles }
  | { ok: false; error: string };

export interface EnsureProjectRulesInput {
  userId: string;
  projectId: string;
  projectType: "website" | "android" | null | undefined;
  client?: SupabaseClient | null;
}

/**
 * Create the two control files before planning and read both.
 *
 * ⚠️ A FAILURE IS RETURNED, NEVER SWALLOWED. The caller must fail the run (or
 * the project creation) with a truthful message instead of planning without
 * the rules.
 */
export async function ensureProjectRuleFiles(
  input: EnsureProjectRulesInput,
): Promise<ProjectRuleFilesResult> {
  if (input.projectType !== "website") {
    return { ok: true, files: { rules: "", workState: "" } };
  }

  const current = await listFiles(input.projectId, input.client);
  if (isStoreFailure(current)) {
    return {
      ok: false,
      error: `The project rules could not be read before planning: ${current.error}`,
    };
  }

  const byPath = new Map(current.data.map((file) => [file.path, file.content]));
  const existingRules = byPath.get(AGENT_RULES_PATH);

  const seeded = await insertFilesIfMissing(
    input.userId,
    input.projectId,
    [
      { path: AGENT_RULES_PATH, content: AGENT_RULES_CONTENT },
      { path: AGENT_WORK_PATH, content: initialWorkStateContent() },
    ],
    input.client,
  );
  if (isStoreFailure(seeded)) {
    return {
      ok: false,
      error: `The project rules could not be saved before planning: ${seeded.error}`,
    };
  }

  if (existingRules !== AGENT_RULES_CONTENT) {
    const written = await writeFiles(
      input.userId,
      input.projectId,
      [{ path: AGENT_RULES_PATH, content: AGENT_RULES_CONTENT }],
      [],
      input.client,
    );
    if (isStoreFailure(written)) {
      return {
        ok: false,
        error: `The project rules could not be saved before planning: ${written.error}`,
      };
    }
  }

  const persisted = await listFiles(input.projectId, input.client);
  if (isStoreFailure(persisted)) {
    return {
      ok: false,
      error: `The project rules could not be verified before planning: ${persisted.error}`,
    };
  }
  const persistedByPath = new Map(
    persisted.data.map((file) => [file.path, file.content]),
  );
  const rules = persistedByPath.get(AGENT_RULES_PATH);
  const workState = persistedByPath.get(AGENT_WORK_PATH);
  if (rules !== AGENT_RULES_CONTENT || typeof workState !== "string") {
    return {
      ok: false,
      error: "The project rules and work-state files were not both persisted and readable before planning.",
    };
  }

  return {
    ok: true,
    files: { rules, workState },
  };
}

export type WorkStateWriteResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * Append one successful-work entry after source generation and structural
 * verification. The run is not finalized until this entry is persisted.
 */
export async function updateProjectWorkState(input: {
  userId: string;
  projectId: string;
  client?: SupabaseClient | null;
  entry: WorkLogInput;
}): Promise<WorkStateWriteResult> {
  const current = await listFiles(input.projectId, input.client);
  if (isStoreFailure(current)) {
    return {
      ok: false,
      error: `The work log could not be read: ${current.error}`,
    };
  }
  const existing =
    current.data.find((file) => file.path === AGENT_WORK_PATH)?.content ?? "";
  /**
   * A retried attempt may finish after an earlier attempt already recorded the
   * same successful run (for example, a crash after this write and before the
   * terminal run update). One run gets at most one entry.
   */
  if (existing.includes(`- Run: ${input.entry.runId}`)) {
    return { ok: true, content: existing };
  }
  const content = mergeWorkState(existing, buildWorkLogEntry(input.entry));

  const written = await writeFiles(
    input.userId,
    input.projectId,
    [{ path: AGENT_WORK_PATH, content }],
    [],
    input.client,
  );
  if (isStoreFailure(written)) {
    return { ok: false, error: `The work log could not be saved: ${written.error}` };
  }
  const persisted = await listFiles(input.projectId, input.client);
  if (isStoreFailure(persisted)) {
    return { ok: false, error: `The work log could not be verified: ${persisted.error}` };
  }
  const savedContent = persisted.data.find(
    (file) => file.path === AGENT_WORK_PATH,
  )?.content;
  if (savedContent !== content) {
    return { ok: false, error: "The work log was not persisted as expected." };
  }
  return { ok: true, content: savedContent };
}

export type SelectionRuleWriteResult =
  | { ok: true; updated: boolean; path: string | null; alreadyPresent: boolean }
  | { ok: false; error: string };

/**
 * Deterministically add the black/white `::selection` rule to the project's
 * existing global stylesheet. Returns `updated: false` when the rule is already
 * present or the project has no stylesheet to add it to.
 */
export async function applySelectionRule(input: {
  userId: string;
  projectId: string;
  client?: SupabaseClient | null;
  files: readonly { path: string; content: string }[];
}): Promise<SelectionRuleWriteResult> {
  const patch = ensureSelectionRule(input.files);
  if (!patch) {
    const sheet = findGlobalStylesheet(input.files);
    return {
      ok: true,
      updated: false,
      path: sheet?.path ?? null,
      alreadyPresent: !!sheet && hasSelectionRule(sheet.content),
    };
  }

  const written = await writeFiles(
    input.userId,
    input.projectId,
    [patch],
    [],
    input.client,
  );
  if (isStoreFailure(written)) {
    return {
      ok: false,
      error: `The global selection rule could not be saved: ${written.error}`,
    };
  }
  const persisted = await listFiles(input.projectId, input.client);
  if (isStoreFailure(persisted)) {
    return {
      ok: false,
      error: `The global selection rule could not be verified: ${persisted.error}`,
    };
  }
  const savedContent = persisted.data.find(
    (file) => file.path === patch.path,
  )?.content;
  if (typeof savedContent !== "string" || !hasSelectionRule(savedContent)) {
    return {
      ok: false,
      error: "The global text-selection rule was not persisted as expected.",
    };
  }
  return { ok: true, updated: true, path: patch.path, alreadyPresent: false };
}
