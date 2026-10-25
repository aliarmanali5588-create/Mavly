/**
 * Resolves the Vercel project that a publish should target.
 *
 * The deployment row can hold a `vercel_project_id` from an earlier publish.
 * That id may now be inaccessible: it can have been deleted, or it can belong to
 * an account/team that the current credentials cannot read (for example after
 * the publishing account was corrected).
 *
 * ⚠️ AN INACCESSIBLE ID IS NEVER DELETED. Vercel owns that project and its
 * domain; Mavly only holds a local reference. Recovery tries the deterministic
 * project name in the currently configured scope, then creates it there. The
 * stored id is replaced only after that lookup or creation succeeds.
 */

import type {
  VercelFailure,
  VercelProject,
  VercelResult,
} from "@/lib/vercel/provider";

export interface VercelProjectClient {
  getProject: (idOrName: string) => Promise<VercelResult<VercelProject>>;
  createProject: (name: string) => Promise<VercelResult<VercelProject>>;
}

export interface ResolvedVercelProject {
  project: VercelProject;
  /** The row's saved id was unusable and must be replaced with `project.id`. */
  replacedStoredId: boolean;
}

export type ResolveVercelProjectResult =
  | { ok: true; data: ResolvedVercelProject; failure?: never }
  | { ok: false; failure: VercelFailure; data?: never };

function isFailure<T>(
  result: VercelResult<T>,
): result is { ok: false; failure: VercelFailure } {
  return result.ok === false;
}

export async function resolveVercelProject(
  client: VercelProjectClient,
  input: { storedId: string | null; name: string },
): Promise<ResolveVercelProjectResult> {
  const { storedId, name } = input;

  if (storedId) {
    const stored = await client.getProject(storedId);
    if (!isFailure(stored)) {
      return { ok: true, data: { project: stored.data, replacedStoredId: false } };
    }

    /**
     * A transient read failure is not proof that the project is gone. Keep the
     * previous behaviour: continue with the saved target and let the following
     * Vercel call decide. Only an explicit 404 (gone) or 401/403 (not accessible
     * with these credentials) triggers name-based recovery.
     */
    if (
      stored.failure.status !== 404 &&
      stored.failure.status !== 401 &&
      stored.failure.status !== 403
    ) {
      return {
        ok: true,
        data: {
          project: { id: storedId, name },
          replacedStoredId: false,
        },
      };
    }

    const named = await client.getProject(name);
    if (!isFailure(named)) {
      return { ok: true, data: { project: named.data, replacedStoredId: true } };
    }
    if (named.failure.status !== 404) {
      return { ok: false, failure: named.failure };
    }
  }

  const created = await client.createProject(name);
  if (!isFailure(created)) {
    return {
      ok: true,
      data: { project: created.data, replacedStoredId: Boolean(storedId) },
    };
  }

  /**
   * A previous attempt may have created the project and then failed before
   * recording its id. Recover by name instead of creating a second project.
   */
  if (created.failure.status === 409) {
    const existing = await client.getProject(name);
    if (!isFailure(existing)) {
      return {
        ok: true,
        data: { project: existing.data, replacedStoredId: Boolean(storedId) },
      };
    }
  }

  return { ok: false, failure: created.failure };
}
