/**
 * Shared response shapes for the Supabase integration. These contain no
 * secrets and may be imported by client components.
 */

export interface SupabaseOrganization {
  id: string;
  slug: string;
  name: string;
}

export interface SupabaseProjectSummary {
  ref: string;
  name: string;
  organizationId: string;
  organizationSlug: string;
  status: string | null;
}

export interface SupabaseSelectedProject {
  ref: string;
  name: string;
  organizationId: string;
  organizationSlug: string;
}

export interface SupabaseIntegrationSummary {
  connected: boolean;
  selectedProject: SupabaseSelectedProject | null;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
}
