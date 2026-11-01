/**
 * ═══ THE SUPABASE ACTION BROKER ═════════════════════════════════════════════
 *
 * The only path from an agent (or the UI) to a customer's Supabase project.
 *
 * ⚠️ THE AGENT NEVER RECEIVES A TOKEN. It proposes a structured action; this
 * module resolves the token server-side, checks that the action is allowlisted,
 * that the granted scopes cover it, that the project belongs to the caller, and
 * that a destructive statement carries explicit approval. Only then does it call
 * the Management API.
 *
 * ⚠️ THE ACTION SET IS CLOSED. `SUPABASE_ACTIONS` is an exhaustive list; there is
 * no "run this raw request" action and no way to supply a host, a path or a
 * method. Adding an action is a code change, not a payload.
 *
 * ⚠️ THIS MODULE IS PURE WHERE IT MATTERS. Classification, scope and approval
 * decisions are pure functions so they can be tested without a network or a
 * database. Execution is the thin part at the bottom.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SupabaseOAuthConfig } from "./config";
import {
  isSupabaseOAuthFailure,
  listEdgeFunctions,
  listOrganizations,
  readProjectConfig,
  listProjects,
  readDatabaseSchema,
  refreshSupabaseToken,
  runDatabaseQuery,
  type SupabaseOAuthResult,
} from "./oauth";
import { classifySql, sqlRequiresApproval, type SqlRisk } from "./sql-policy";
import { SUPABASE_REQUIRED_SCOPES } from "./config";
import { markStatus, readTokens, recordAudit, saveConnection } from "./store";

/* ───────────────────────────── The action set ──────────────────────────── */

/**
 * ⚠️ `run_sql` IS THE ONLY ACTION THAT CAN CHANGE A CUSTOMER DATABASE, and it is
 * gated on approval. Everything else is read-only.
 */
export const SUPABASE_ACTIONS = [
  "list_organizations",
  "list_projects",
  "read_project_config",
  "read_schema",
  "list_edge_functions",
  "run_sql",
] as const;

export type SupabaseActionName = (typeof SUPABASE_ACTIONS)[number];

export function isSupabaseAction(value: unknown): value is SupabaseActionName {
  return typeof value === "string" && (SUPABASE_ACTIONS as readonly string[]).includes(value);
}

/** The scope each action requires. `null` means no scope is needed. */
const ACTION_SCOPE: Readonly<Record<SupabaseActionName, string | null>> = {
  list_organizations: "organizations:read",
  list_projects: "projects:read",
  read_project_config: "projects:read",
  read_schema: "database:read",
  /**
   * ⚠️ EDGE FUNCTION LISTING IS A READ. Deploying or deleting one would need
   * `edge_functions:write`, and no such action exists in `SUPABASE_ACTIONS`.
   * Adding one without adding that scope here would be a silent privilege
   * broadening, so the two must change together.
   */
  list_edge_functions: "edge_functions:read",
  run_sql: "database:write",
};

/** Actions that can never change state. Used to decide whether approval applies. */
const READ_ONLY_ACTIONS: ReadonlySet<SupabaseActionName> = new Set([
  "list_organizations",
  "list_projects",
  "read_project_config",
  "read_schema",
  "list_edge_functions",
]);

export function actionRequiresScope(action: SupabaseActionName): string | null {
  return ACTION_SCOPE[action];
}

/**
 * ═══ THE SCOPE TABLE CANNOT DRIFT FROM THE DECLARED SET ═════════════════════
 *
 * ⚠️ EVERY SCOPE AN ACTION REQUIRES MUST BE ONE MAVLY ACTUALLY DECLARES. If an
 * action were pointed at a scope outside `SUPABASE_REQUIRED_SCOPES`, the broker
 * would demand a permission the OAuth app never asks for — so the action would
 * fail closed — or, worse, someone would "fix" it by widening the required set.
 * This makes that mistake loud at module load instead of silent at runtime.
 *
 * ⚠️ IT DOES NOT BROADEN ANYTHING. It only asserts that what is already required
 * is a subset of what is already declared. Adding a write scope still requires
 * editing `SUPABASE_REQUIRED_SCOPES` deliberately.
 */
const UNDECLARED_SCOPES = (Object.entries(ACTION_SCOPE) as Array<[string, string | null]>)
  .filter(([, scope]) => scope !== null && !(SUPABASE_REQUIRED_SCOPES as readonly string[]).includes(scope))
  .map(([action, scope]) => `${action}→${scope}`);

if (UNDECLARED_SCOPES.length > 0) {
  throw new Error(
    `[supabase-broker] action scopes not in SUPABASE_REQUIRED_SCOPES: ${UNDECLARED_SCOPES.join(", ")}`,
  );
}

/**
 * ⚠️ AND EVERY DECLARED SCOPE MUST BE USED BY SOME ACTION. A declared scope no
 * action needs is a permission Mavly asks the user for and never uses, which is
 * exactly the silent broadening this patch is meant to prevent.
 */
const UNUSED_SCOPES = (SUPABASE_REQUIRED_SCOPES as readonly string[]).filter(
  (scope) => !Object.values(ACTION_SCOPE).includes(scope),
);

if (UNUSED_SCOPES.length > 0) {
  throw new Error(
    `[supabase-broker] SUPABASE_REQUIRED_SCOPES declares unused scopes: ${UNUSED_SCOPES.join(", ")}`,
  );
}

export function isReadOnlyAction(action: SupabaseActionName): boolean {
  return READ_ONLY_ACTIONS.has(action);
}

/* ─────────────────────────── SQL classification ────────────────────────── */

/**
 * ⚠️ THE CLASSIFIER LIVES IN `sql-policy.ts`, NOT HERE. It is pure, and the
 * orchestration layer needs it at validation time without importing the
 * Management API client, the token store or the encryption key. Re-exported so
 * existing callers and tests keep one import site.
 */
export { classifySql, sqlRequiresApproval } from "./sql-policy";
export type { SqlRisk, SqlClassification } from "./sql-policy";

/* ───────────────────────────── The decision ────────────────────────────── */

export type BrokerRefusalCode =
  | "action_not_allowed"
  | "invalid_arguments"
  | "not_connected"
  | "scope_missing"
  | "statement_blocked"
  | "approval_required"
  | "project_not_authorized"
  | "token_expired"
  | "token_revoked";

export interface BrokerRefusal {
  ok: false;
  code: BrokerRefusalCode;
  message: string;
  /** True when repeating the request with `approved: true` may succeed. */
  retryableWithApproval: boolean;
  /** The classification, when the refusal was about SQL. */
  sqlRisk?: SqlRisk;
}

export interface BrokerApproval {
  ok: true;
  action: SupabaseActionName;
  projectRef: string;
  /** Present for `run_sql`; the statement the user approved. */
  statement?: string;
  sqlRisk?: SqlRisk;
}

export type BrokerDecision = BrokerApproval | BrokerRefusal;

function refuse(
  code: BrokerRefusalCode,
  message: string,
  options: { retryableWithApproval?: boolean; sqlRisk?: SqlRisk } = {},
): BrokerRefusal {
  return {
    ok: false,
    code,
    message,
    retryableWithApproval: options.retryableWithApproval ?? false,
    ...(options.sqlRisk ? { sqlRisk: options.sqlRisk } : {}),
  };
}

/**
 * ═══ THE AUTHORIZATION DECISION ═════════════════════════════════════════════
 *
 * Pure: everything it needs is passed in. This is the function the tests exercise
 * and the function execution obeys, so there is no second, weaker check.
 *
 * Order matters, and it is deliberate:
 *   1. the action is allowlisted
 *   2. the connection exists and is usable
 *   3. the granted scopes cover the action
 *   4. the SQL is classified and blocked if it must be
 *   5. destructive SQL needs explicit approval
 */
export function decideBrokerAction(input: {
  action: unknown;
  projectRef: unknown;
  connection: {
    projectRef: string | null;
    status: string;
    grantedScopes: string[];
  } | null;
  statement?: unknown;
  approved: boolean;
}): BrokerDecision {
  const { action, projectRef, connection, approved } = input;

  if (!isSupabaseAction(action)) {
    return refuse("action_not_allowed", "That action is not available.");
  }
  if (typeof projectRef !== "string" || !/^[a-z0-9]{6,40}$/.test(projectRef)) {
    return refuse("invalid_arguments", "A valid Supabase project is required.");
  }

  if (!connection) {
    return refuse("not_connected", "Connect a Supabase project first.");
  }
  /**
   * ⚠️ A PENDING ROW HOLDS A TOKEN BUT NO PROJECT. It must never authorize an
   * action: the user authorized Mavly but has not said which project to use.
   */
  if (connection.status === "pending_selection" || !connection.projectRef) {
    return refuse("not_connected", "Choose a Supabase project to finish connecting.");
  }
  /**
   * ⚠️ THE CONNECTION MUST BE FOR THE PROJECT BEING ASKED ABOUT. A row for
   * project A must never authorize an action against project B, even when both
   * belong to the same user.
   */
  if (connection.projectRef !== projectRef) {
    return refuse("project_not_authorized", "That project is not the connected one.");
  }
  if (connection.status === "revoked") {
    return refuse("token_revoked", "Supabase access was revoked. Reconnect to continue.");
  }
  if (connection.status === "expired" || connection.status === "reconnection_required") {
    return refuse("token_expired", "The Supabase authorization expired. Reconnect to continue.");
  }

  const requiredScope = ACTION_SCOPE[action];
  if (requiredScope && !connection.grantedScopes.includes(requiredScope)) {
    return refuse(
      "scope_missing",
      `This connection was not granted the ${requiredScope} scope.`,
    );
  }

  if (action === "run_sql") {
    const classification = classifySql(input.statement);
    if (classification.risk === "blocked") {
      return refuse(
        "statement_blocked",
        "That statement is not allowed through Mavly. Run it in the Supabase SQL editor instead.",
        { sqlRisk: "blocked" },
      );
    }
    if (sqlRequiresApproval(classification) && !approved) {
      return refuse(
        "approval_required",
        "This statement changes your database. Confirm it to continue.",
        { retryableWithApproval: true, sqlRisk: classification.risk },
      );
    }
    return {
      ok: true,
      action,
      projectRef,
      statement: String(input.statement),
      sqlRisk: classification.risk,
    };
  }

  return { ok: true, action, projectRef };
}

/* ───────────────────────────── Execution ───────────────────────────────── */

export interface BrokerExecutionFailure {
  ok: false;
  code: BrokerRefusalCode | "upstream_failed";
  message: string;
}

export type BrokerExecution =
  | { ok: true; action: SupabaseActionName; data: unknown }
  | BrokerExecutionFailure;

/**
 * Resolve a usable access token, refreshing when it is close to expiry.
 *
 * ⚠️ A REFUSED REFRESH IS TERMINAL. Supabase answers 401 when the user revoked
 * the app; that is `reconnection_required`, not a transient error to retry.
 */
async function resolveAccessToken(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: SupabaseOAuthConfig;
}): Promise<
  | { ok: true; accessToken: string; projectRef: string | null; grantedScopes: string[] }
  | BrokerExecutionFailure
> {
  const stored = await readTokens({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: input.config,
  });
  if (stored.ok === false) {
    return { ok: false, code: "not_connected", message: "The Supabase connection could not be read." };
  }
  if (!stored.data || !stored.data.accessToken) {
    return { ok: false, code: "not_connected", message: "Connect a Supabase project first." };
  }

  const { accessToken, refreshToken, expiresAt, projectRef, grantedScopes } = stored.data;

  /**
   * Refresh a minute early so a call cannot expire in flight.
   *
   * ⚠️ A NULL EXPIRY IS TREATED AS EXPIRING NOW, NOT AS VALID FOREVER. The stored
   * row cannot tell us whether the token has a lifetime at all, so the safe read
   * is "assume it is about to die". With a refresh token we refresh; without one
   * we refuse rather than use a credential of unknown age indefinitely.
   */
  const parsedExpiry = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  const expiringSoon =
    expiresAt === null ||
    !Number.isFinite(parsedExpiry) ||
    parsedExpiry - Date.now() < 60_000;

  if (!expiringSoon) {
    return { ok: true, accessToken, projectRef, grantedScopes };
  }

  if (!refreshToken) {
    return {
      ok: false,
      code: "token_expired",
      message: "The Supabase authorization expired. Reconnect to continue.",
    };
  }
  /**
   * ⚠️ A REFRESH TOKEN IS A WORKING CREDENTIAL. Refusing here because the access
   * token is near expiry would tell the user to reconnect while Mavly still holds
   * everything it needs to continue — and would make every action fail for the
   * last minute of every token's life.
   *
   * The refresh is done here rather than in `service.ts` because `service.ts`
   * imports this module; calling back into it would be a cycle. `oauth.ts` and
   * `store.ts` are already dependencies of this file, so the exchange and the
   * write-back need nothing new.
   */
  const refreshed = await refreshSupabaseToken(input.config, refreshToken);
  if (refreshed.ok === false) {
    /**
     * ⚠️ A REFUSED REFRESH IS TERMINAL. Supabase answers 401 when the user revoked
     * the app. Marking the row keeps the UI honest and stops every later action
     * from retrying a credential that will never work again.
     */
    const revoked = refreshed.code === "supabase_unauthorized";
    await markStatus({
      client: input.client,
      projectId: input.projectId,
      status: revoked ? "revoked" : "reconnection_required",
      lastError: revoked
        ? "Supabase access was revoked."
        : "The Supabase authorization could not be refreshed.",
    });
    return {
      ok: false,
      code: revoked ? "token_revoked" : "token_expired",
      message: revoked
        ? "Supabase access was revoked. Reconnect to continue."
        : "The Supabase authorization could not be refreshed. Reconnect to continue.",
    };
  }

  const saved = await saveConnection({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: input.config,
    projectRef,
    /**
     * ⚠️ NAME AND ORGANIZATION ARE NOT RE-SENT. A refresh must not blank metadata
     * the selection step wrote; the RPC coalesces nulls for exactly this reason.
     */
    projectName: null,
    organizationSlug: null,
    accessToken: refreshed.data.accessToken,
    refreshToken: refreshed.data.refreshToken ?? refreshToken,
    expiresAt: refreshed.data.expiresAt,
    grantedScopes:
      refreshed.data.grantedScopes.length > 0
        ? refreshed.data.grantedScopes
        : grantedScopes,
  });
  if (saved.ok === false) {
    return {
      ok: false,
      code: "not_connected",
      message: "The refreshed Supabase authorization could not be stored.",
    };
  }

  return {
    ok: true,
    accessToken: refreshed.data.accessToken,
    projectRef,
    grantedScopes:
      refreshed.data.grantedScopes.length > 0
        ? refreshed.data.grantedScopes
        : grantedScopes,
  };
}

/**
 * Execute an approved action.
 *
 * ⚠️ THE DECISION IS RE-RUN HERE, NOT TRUSTED FROM THE CALLER. A caller that
 * hands in a `BrokerApproval` still goes through `decideBrokerAction` again with
 * the live connection, so a stale approval cannot outlive a revocation.
 */
export async function executeBrokerAction(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: SupabaseOAuthConfig;
  action: unknown;
  projectRef: unknown;
  statement?: unknown;
  approved: boolean;
}): Promise<BrokerExecution> {
  const stored = await readTokens({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: input.config,
  });
  if (stored.ok === false) {
    return { ok: false, code: "not_connected", message: "The Supabase connection could not be read." };
  }
  if (!stored.data) {
    return { ok: false, code: "not_connected", message: "Connect a Supabase project first." };
  }

  const decision = decideBrokerAction({
    action: input.action,
    projectRef: input.projectRef,
    connection: {
      projectRef: stored.data.projectRef,
      status: stored.data.status,
      grantedScopes: stored.data.grantedScopes,
    },
    statement: input.statement,
    approved: input.approved,
  });

  if (decision.ok === false) {
    await recordAudit({
      client: input.client,
      projectId: input.projectId,
      projectRef: stored.data.projectRef,
      action: isSupabaseAction(input.action) ? input.action : "unknown",
      outcome: decision.retryableWithApproval ? "pending_approval" : "refused",
      reasonCode: decision.code,
      metadata: { sqlRisk: decision.sqlRisk ?? null },
    });
    return { ok: false, code: decision.code, message: decision.message };
  }

  const token = await resolveAccessToken({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: input.config,
  });
  if (token.ok === false) {
    await recordAudit({
      client: input.client,
      projectId: input.projectId,
      projectRef: stored.data.projectRef,
      action: decision.action,
      outcome: "failed",
      reasonCode: token.code,
      metadata: {},
    });
    return token;
  }

  /**
   * ═══ THE APPROVAL IS RE-CHECKED HERE, IMMEDIATELY BEFORE EXECUTION ═══════
   *
   * ⚠️ NOT ONLY AT CLASSIFICATION TIME. The decision above ran against the
   * connection as it was read at the start of this call. A refresh inside
   * `resolveAccessToken` can rewrite the stored row (scopes, status), so the
   * statement is re-classified and the scope re-checked against the LIVE token
   * result before anything reaches the network.
   *
   * This is cheap and pure, and it means a statement cannot be approved against
   * one connection state and executed under another.
   */
  if (decision.action === "run_sql") {
    const recheck = classifySql(decision.statement);
    if (recheck.risk === "blocked") {
      await recordAudit({
        client: input.client,
        projectId: input.projectId,
        projectRef: decision.projectRef,
        action: decision.action,
        outcome: "refused",
        reasonCode: "statement_blocked",
        metadata: { sqlRisk: "blocked" },
      });
      return {
        ok: false,
        code: "statement_blocked",
        message:
          "That statement is not allowed through Mavly. Run it in the Supabase SQL editor instead.",
      };
    }
    if (sqlRequiresApproval(recheck) && !input.approved) {
      await recordAudit({
        client: input.client,
        projectId: input.projectId,
        projectRef: decision.projectRef,
        action: decision.action,
        outcome: "pending_approval",
        reasonCode: "approval_required",
        metadata: { sqlRisk: recheck.risk },
      });
      return {
        ok: false,
        code: "approval_required",
        message: "This statement changes your database. Confirm it to continue.",
      };
    }
  }

  /**
   * ⚠️ THE SCOPE IS RE-CHECKED AGAINST THE TOKEN THAT WILL ACTUALLY BE USED. A
   * refresh can return a narrower grant than the one the decision saw.
   */
  const liveScope = ACTION_SCOPE[decision.action];
  if (liveScope && !token.grantedScopes.includes(liveScope)) {
    await recordAudit({
      client: input.client,
      projectId: input.projectId,
      projectRef: decision.projectRef,
      action: decision.action,
      outcome: "refused",
      reasonCode: "scope_missing",
      metadata: {},
    });
    return {
      ok: false,
      code: "scope_missing",
      message: `This connection was not granted the ${liveScope} scope.`,
    };
  }

  const run = async (): Promise<SupabaseOAuthResult<unknown>> => {
    switch (decision.action) {
      case "list_organizations":
        return listOrganizations(token.accessToken);
      case "list_projects":
        return listProjects(token.accessToken);
      case "read_project_config":
        return readProjectConfig(token.accessToken, decision.projectRef);
      case "read_schema":
        return readDatabaseSchema(token.accessToken, decision.projectRef);
      case "list_edge_functions":
        return listEdgeFunctions(token.accessToken, decision.projectRef);
      case "run_sql":
        return runDatabaseQuery(
          token.accessToken,
          decision.projectRef,
          decision.statement ?? "",
        );
    }
  };

  const result = await run();

  if (isSupabaseOAuthFailure(result)) {
    /**
     * ⚠️ A 401 FROM SUPABASE MEANS THE TOKEN IS DEAD, NOT THAT THE REQUEST WAS
     * MALFORMED. It is reported as a revocation so the UI can ask for a
     * reconnection instead of retrying forever.
     */
    const revoked = result.code === "supabase_unauthorized";
    await recordAudit({
      client: input.client,
      projectId: input.projectId,
      projectRef: decision.projectRef,
      action: decision.action,
      outcome: "failed",
      reasonCode: result.code,
      metadata: { sqlRisk: decision.sqlRisk ?? null },
    });
    return {
      ok: false,
      code: revoked ? "token_revoked" : "upstream_failed",
      message: revoked
        ? "Supabase rejected the authorization. Reconnect to continue."
        : "Supabase could not complete that action.",
    };
  }

  /**
   * ⚠️ THE AUDIT RECORDS THE ACTION AND ITS RISK, NEVER THE STATEMENT OR ITS
   * RESULT. A row count is a safe summary; the rows themselves are not.
   */
  await recordAudit({
    client: input.client,
    projectId: input.projectId,
    projectRef: decision.projectRef,
    action: decision.action,
    outcome: "allowed",
    reasonCode: null,
    metadata: {
      sqlRisk: decision.sqlRisk ?? null,
      resultKind: Array.isArray(result.data) ? "list" : "object",
      resultCount: Array.isArray(result.data) ? result.data.length : null,
    },
  });

  return { ok: true, action: decision.action, data: result.data };
}
