/**
 * ═══ OWNER-VISIBLE BACKEND STATUS ══════════════════════════════════════════
 *
 * One projection, used by the authenticated status surface and the generation
 * completion message, so the workspace and the chat cannot disagree about what
 * is live. Every capability is derived from a stored fact — never from the
 * planner's intent, and never from "a Neon project exists".
 *
 * Pure: no I/O.
 */

import {
  managedBackendCapabilities,
  managedBackendNextAction,
  managedBackendStateLabel,
  type ManagedBackendCapabilities,
  type ManagedBackendFacts,
  type ManagedBackendState,
} from "./lifecycle";
import type { AppDataModel } from "./model";

export interface ManagedBackendStatusView {
  state: ManagedBackendState;
  label: string;
  capabilities: ManagedBackendCapabilities;
  tables: Array<{
    name: string;
    operations: string[];
    ownership: "user" | "public";
    columns: string[];
  }>;
  authenticationRequired: boolean;
  errorCode: string | null;
  lastStep: string | null;
  updatedAt: string | null;
  nextAction: string | null;
}

export function managedBackendStatusView(input: {
  state: ManagedBackendState;
  dataModel: AppDataModel | null;
  authRequired: boolean;
  connectionVerified: boolean;
  schemaVerified: boolean;
  gatewayConfigured: boolean;
  errorCode: string | null;
  lastStep: string | null;
  updatedAt: string | null;
  /** Used only for `pending_approval`, which has no registry row. */
  blockedReason?: string | null;
}): ManagedBackendStatusView {
  const model = input.dataModel;
  const facts: ManagedBackendFacts = {
    state: input.state,
    connectionVerified: input.connectionVerified,
    schemaVerified: input.schemaVerified,
    modelRegistered: model !== null,
    gatewayConfigured: input.gatewayConfigured,
    authenticationRequired: input.authRequired,
    tableCount: model?.tables.length ?? 0,
  };
  const capabilities = managedBackendCapabilities(facts);
  const tables = (model?.tables ?? []).map((table) => {
    const resource = model?.resources.find((entry) => entry.table === table.name);
    return {
      name: table.name,
      operations: resource?.operations ?? [],
      ownership: table.userOwned ? ("user" as const) : ("public" as const),
      columns: table.columns.map((column) => column.name),
    };
  });

  return {
    state: input.state,
    label:
      input.state === "pending_approval" && input.blockedReason
        ? `${managedBackendStateLabel(input.state)} ${input.blockedReason}`
        : managedBackendStateLabel(input.state),
    capabilities,
    tables,
    authenticationRequired: facts.authenticationRequired && capabilities.authentication,
    errorCode: input.errorCode,
    lastStep: input.lastStep,
    updatedAt: input.updatedAt,
    nextAction: managedBackendNextAction(facts),
  };
}
