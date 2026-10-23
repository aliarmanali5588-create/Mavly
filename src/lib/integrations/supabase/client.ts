/**
 * Same-origin client for the Supabase integration routes.
 *
 * Components call this module, not `/api/...` directly. It contains no secrets
 * and no server-only imports.
 */

import type {
  SupabaseIntegrationSummary,
  SupabaseOrganization,
  SupabaseProjectSummary,
} from "./types";

const API = "/api/integrations/supabase";

export interface SupabaseIntegrationFailure {
  ok: false;
  error: string;
  code?: string;
  status?: number;
}

export type SupabaseIntegrationSuccess<T> = { ok: true; data: T };
export type SupabaseIntegrationResponse<T> =
  | SupabaseIntegrationSuccess<T>
  | SupabaseIntegrationFailure;

export function isSupabaseIntegrationFailure<T>(
  result: SupabaseIntegrationResponse<T>,
): result is SupabaseIntegrationFailure {
  return result.ok === false;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<SupabaseIntegrationResponse<T>> {
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
    });
    const body = (await response.json()) as SupabaseIntegrationResponse<T>;
    if (!body || typeof body !== "object") {
      return {
        ok: false,
        error: "The Supabase integration returned an unexpected response.",
        status: response.status,
      };
    }
    if (isSupabaseIntegrationFailure(body)) {
      return { ...body, status: response.status };
    }
    return body;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The Supabase integration could not be reached.",
    };
  }
}

function post<T>(path: string, body: unknown): Promise<SupabaseIntegrationResponse<T>> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const supabaseIntegrationApi = {
  status: () => request<SupabaseIntegrationSummary>("/status"),
  start: (returnTo: string) =>
    post<{ authorizationUrl: string }>("/start", { returnTo }),
  organizations: () =>
    request<{ organizations: SupabaseOrganization[] }>("/organizations"),
  projects: () =>
    request<{ projects: SupabaseProjectSummary[] }>("/projects"),
  select: (projectRef: string) =>
    post<SupabaseIntegrationSummary>("/select", { projectRef }),
  disconnect: () =>
    post<{ connected: false; revoked?: boolean }>("/disconnect", {}),
};
