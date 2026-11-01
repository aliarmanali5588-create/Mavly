import type { NextRequest } from "next/server";

import { authorizeProjectRequest } from "@/app/api/vcaas/_shared";
import {
  connectSupabaseBackend,
  disconnectSupabaseBackend,
  readBackendCenter,
  switchBackendProvider,
} from "@/lib/backend-providers/service";
import { isBackendProvider } from "@/lib/backend-providers/types";
import { managedBackendStatus } from "@/lib/managed-backend/store";
import { readOwnEnrollment } from "@/lib/managed-backend/enrollment-store";
import { apiData, apiError } from "@/lib/integrations/github/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ═══ THE PROJECT'S BACKEND PROVIDERS ════════════════════════════════════════
 *
 * One route for the Backend & Source Control Center's database half. GitHub is
 * deliberately NOT here: it is source control, it has its own routes under
 * `/api/integrations/github`, and coupling the two would imply a project needs
 * GitHub to have a database.
 *
 * ⚠️ AUTHORIZATION ORDER, EVERY METHOD: a verified Mavly session, then the
 * project's ownership row, and only then the provider table. The RPCs re-check
 * ownership themselves, so this route is a fast, honest refusal rather than the
 * security boundary.
 *
 * ⚠️ NO METHOD RETURNS A CREDENTIAL. `hasServiceRoleKey` is a boolean.
 */

async function authorize(projectId: string) {
  const authorized = await authorizeProjectRequest(projectId);
  if ("response" in authorized) return { response: authorized.response };

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      response: apiError(
        "SUPABASE_UNAVAILABLE",
        "The project database is not configured on this deployment.",
        503,
      ),
    };
  }
  /**
   * ⚠️ THE VERIFIED USER ID IS REQUIRED, NOT COSMETIC. The service-role
   * ciphertext's associated data binds it to this user, so encrypting under a
   * different (or empty) id would produce a key that can never be decrypted.
   */
  return { supabase, userId: authorized.team.userId };
}

/** GET — the provider rows and the active provider. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if ("response" in auth) return auth.response;

  /**
   * The managed backend's lifecycle state is read here rather than in the
   * component: `managedBackend` rides on `agent/status`, and making the Database
   * page poll a second endpoint just to learn one string would be wasteful and
   * would give the page two sources of truth.
   */
  const lifecycle = await managedBackendStatus({
    client: auth.supabase,
    projectId,
  });
  const managedBackendState =
    lifecycle.ok && lifecycle.data ? lifecycle.data.status : null;

  const enrollment = await readOwnEnrollment({
    client: auth.supabase,
    projectId,
  });

  const center = await readBackendCenter({
    client: auth.supabase,
    projectId,
    managedBackendState,
  });
  if (center.ok === false) {
    return apiError(center.code, center.message, center.status);
  }
  return apiData({
    center: center.data,
    managedBackend: {
      state: managedBackendState,
      enrollment:
        enrollment.ok && enrollment.data
          ? {
              state: enrollment.data.status,
              reasonCode: enrollment.data.reasonCode,
            }
          : null,
    },
  });
}

/**
 * POST — connect, switch, or disconnect.
 *
 * The action is an explicit discriminator rather than an inferred shape, so a
 * malformed body can never be guessed into a destructive operation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorize(projectId);
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_BODY", "The request body is not valid JSON.", 400);
  }
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!record) return apiError("INVALID_BODY", "The request body is not valid.", 400);

  const action = record.action;

  if (action === "connect_supabase") {
    const credentials =
      record.credentials && typeof record.credentials === "object"
        ? (record.credentials as Record<string, unknown>)
        : null;
    if (!credentials) {
      return apiError("INVALID_BODY", "Supabase credentials are required.", 400);
    }
    const connected = await connectSupabaseBackend({
      client: auth.supabase,
      userId: auth.userId,
      projectId,
      credentials: {
        projectUrl:
          typeof credentials.projectUrl === "string" ? credentials.projectUrl : "",
        anonKey: typeof credentials.anonKey === "string" ? credentials.anonKey : "",
        serviceRoleKey:
          typeof credentials.serviceRoleKey === "string" ? credentials.serviceRoleKey : "",
      },
    });
    if (connected.ok === false) {
      return apiError(connected.code, connected.message, connected.status);
    }
    return apiData({ provider: connected.data.provider });
  }

  if (action === "switch") {
    const target = record.provider;
    if (!isBackendProvider(target)) {
      return apiError("INVALID_PROVIDER", "Choose a supported backend provider.", 400);
    }
    const switched = await switchBackendProvider({
      client: auth.supabase,
      projectId,
      target,
      confirmed: record.confirmed === true,
    });
    if (switched.ok === false) {
      return apiError(switched.code, switched.message, switched.status);
    }
    return apiData({
      activeProvider: switched.data.activeProvider,
      center: switched.data.view,
    });
  }

  if (action === "disconnect_supabase") {
    const disconnected = await disconnectSupabaseBackend({
      client: auth.supabase,
      projectId,
    });
    if (disconnected.ok === false) {
      return apiError(disconnected.code, disconnected.message, disconnected.status);
    }
    return apiData({ provider: disconnected.data.provider });
  }

  return apiError(
    "INVALID_ACTION",
    "Supported actions are connect_supabase, switch and disconnect_supabase.",
    400,
  );
}
