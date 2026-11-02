/**
 * ═══ ENABLE THE MAVLY-MANAGED BACKEND ═══════════════════════════════════════
 *
 * Split from `service.ts` so the connect/switch/disconnect paths stay readable
 * and this one file owns the single "Enable Backend" decision.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { managedBackendConfig } from "@/lib/managed-backend/config";
import { ensureEnrollment } from "@/lib/managed-backend/enrollment-service";

import {
  activateBackendProvider,
  readBackendProviders,
  type BackendProviderStoreFailureCode,
} from "./store";
import {
  buildBackendCenterView,
  type BackendCenterView,
  type BackendProvider,
} from "./types";

export interface EnableManagedFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
}

export type EnableManagedResult =
  | {
      ok: true;
      data: {
        outcome: "activated" | "already_active" | "awaiting_generation" | "blocked";
        activeProvider: BackendProvider | null;
        view: BackendCenterView;
        message: string;
      };
    }
  | EnableManagedFailure;

/**
 * Map a store failure to a user-facing answer. Mirrors `service.ts` so the two
 * cannot report the same storage problem differently.
 */
function storeFailure(
  code: BackendProviderStoreFailureCode,
  action: string,
): EnableManagedFailure {
  switch (code) {
    case "migration_required":
      return {
        ok: false,
        code: "BACKEND_PROVIDERS_MIGRATION_REQUIRED",
        message:
          "Backend provider storage is not installed. Apply supabase/migrations/39_backend_providers.sql.",
        status: 503,
      };
    case "forbidden":
      return {
        ok: false,
        code: "BACKEND_PROVIDERS_FORBIDDEN",
        message: "You do not have access to this project's backend settings.",
        status: 403,
      };
    case "not_found":
      return {
        ok: false,
        code: "BACKEND_PROVIDER_NOT_FOUND",
        message: "That backend is not connected.",
        status: 404,
      };
    case "conflict":
      return {
        ok: false,
        code: "BACKEND_PROVIDER_CONFLICT",
        message: `The backend could not be ${action} in its current state.`,
        status: 409,
      };
    case "unavailable":
      return {
        ok: false,
        code: "BACKEND_PROVIDERS_UNAVAILABLE",
        message: "The backend provider service is unavailable.",
        status: 503,
      };
    default:
      return {
        ok: false,
        code: "BACKEND_PROVIDERS_ERROR",
        message: `The backend could not be ${action}.`,
        status: 500,
      };
  }
}

export async function enableManagedBackend(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
}): Promise<EnableManagedResult> {
  const providers = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (providers.ok === false) return storeFailure(providers.code, "read");

  const active = providers.data.find((entry) => entry.active) ?? null;

  /**
   * ⚠️ A SUPABASE-ACTIVE PROJECT IS REFUSED, NOT SWITCHED. Enabling a backend is
   * not a switch: the brief requires an explicit confirmation for that, and
   * silently replacing a working backend would be the exact behaviour this
   * feature forbids.
   */
  if (active && active.provider === "external_supabase") {
    return {
      ok: true,
      data: {
        outcome: "blocked",
        activeProvider: active.provider,
        view: buildBackendCenterView({
          providers: providers.data,
          managedBackendState: null,
        }),
        message:
          "Your own Supabase backend is currently active for this project. Switch your backend before enabling Mavly's.",
      },
    };
  }

  if (active && active.provider === "mavly_managed_neon") {
    return {
      ok: true,
      data: {
        outcome: "already_active",
        activeProvider: active.provider,
        view: buildBackendCenterView({
          providers: providers.data,
          managedBackendState: null,
        }),
        message: "Mavly's managed backend is already active for this project.",
      },
    };
  }

  /**
   * The managed provider row is registered by the generation run that provisioned
   * it (see `run-agent.ts`). A `ready` row here means the database already exists
   * and was verified, so activating it is a real, safe operation.
   */
  const managedRow =
    providers.data.find((entry) => entry.provider === "mavly_managed_neon") ?? null;

  if (managedRow && managedRow.status === "ready") {
    const activated = await activateBackendProvider({
      client: input.client,
      projectId: input.projectId,
      provider: "mavly_managed_neon",
    });
    if (activated.ok === false) return storeFailure(activated.code, "activated");

    const after = await readBackendProviders({
      client: input.client,
      projectId: input.projectId,
    });
    if (after.ok === false) return storeFailure(after.code, "read");

    return {
      ok: true,
      data: {
        outcome: "activated",
        activeProvider: "mavly_managed_neon",
        view: buildBackendCenterView({
          providers: after.data,
          managedBackendState: null,
        }),
        message: "Mavly's managed backend is now active for this project.",
      },
    };
  }

  /**
   * Nothing is ready yet. The enrollment decision is still worth running: it
   * tells the user whether this project is even eligible, which is the difference
   * between "run a generation" and "this deployment cannot provision for you".
   *
   * ⚠️ `backendRequired: true` AND `hasDataModel: false` ARE THE HONEST INPUTS.
   * The user has just asked for a backend, so a backend is required; no plan has
   * produced a model yet, so there is nothing to apply.
   */
  const config = managedBackendConfig();
  const enrollment = await ensureEnrollment({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config,
    backendRequired: true,
    hasDataModel: false,
  });

  const after = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (after.ok === false) return storeFailure(after.code, "read");

  if (!enrollment.authorized) {
    return {
      ok: true,
      data: {
        outcome: "blocked",
        activeProvider: null,
        view: buildBackendCenterView({
          providers: after.data,
          managedBackendState: null,
        }),
        message: `${enrollment.label} No database was created.`,
      },
    };
  }

  return {
    ok: true,
    data: {
      outcome: "awaiting_generation",
      activeProvider: null,
      view: buildBackendCenterView({
        providers: after.data,
        managedBackendState: null,
      }),
      message:
        "This project is approved for a Mavly-managed database. It is provisioned with the first generation that needs stored data, then becomes active here.",
    },
  };
}
