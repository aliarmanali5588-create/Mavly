/**
 * ═══ TENANT SERVING — THE PUBLIC WEBSITE RUNTIME ════════════════════════════
 *
 * One request in, one static response out:
 *
 *   raw Host ──parseTenantHost──► tenant ──resolve RPC──► ACTIVE version only
 *                     │                                        │
 *                     └─ null ⇒ 404 (never a default site)     └─ file read RPC
 *
 * ⚠️ NO SESSION, NO PROJECT ID, NO DRAFTS. The hostname is the only tenant
 * identity, the version comes from the published mapping, and the file read is
 * pinned to that exact version. `project_files`, the workspace preview and every
 * authenticated API are unreachable from here by construction.
 *
 * ⚠️ CACHING IS OFF UNTIL IT IS PROVEN SAFE. Responses are `no-store`: the app's
 * global policy already forbids caching, and a shared CDN cache keyed only by
 * path would be a cross-tenant leak. A future cache must key on hostname AND
 * the immutable version id in `ResolvedPublishedTenant`; that is why the
 * resolver returns one.
 */

import { parseTenantHost } from "@/lib/tenant-host";

import { isSharedHostingRuntimeEnabled } from "./config";
import { logHostingEvent } from "./events";
import {
  isHostingStoreFailure,
  readPublishedFile,
  resolvePublishedTenant,
  type ResolvedPublishedTenant,
} from "./store";
import { publishedLookupCandidates } from "./published-version";

export interface TenantServeInput {
  /** The raw request host. Parsed here; never trusted as-is. */
  host: string | null;
  /** Already-decoded route segments (never a query or body value). */
  segments: readonly string[];
  method: string;
}

export interface TenantServeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const BASE_HEADERS = {
  /**
   * A published site is untrusted third-party content. `nosniff` prevents a
   * browser from executing an asset as a different type than we declared, and
   * no CSP is added because generated pages legitimately use inline scripts —
   * pretending otherwise would break every published site.
   */
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  /**
   * Deliberately uncached. See the module comment: a host-blind or
   * version-blind cache is a cross-tenant leak, and the version-aware cache has
   * not been proven against the real CDN yet.
   */
  "cache-control": "no-store, max-age=0",
} as const;

function textResponse(status: number, body: string): TenantServeResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" },
    body,
  };
}

/**
 * Serve one tenant request.
 *
 * Status policy:
 *   200 — a file from the active version;
 *   404 — unknown/malformed/reserved host, unpublished tenant, missing file;
 *   405 — anything but GET/HEAD;
 *   503 — the database or RPC failed. NEVER 404: an infrastructure failure must
 *         not tell a visitor (or a crawler) that the site was unpublished.
 */
export async function serveTenantRequest(
  input: TenantServeInput,
): Promise<TenantServeResponse> {
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return {
      status: 405,
      headers: { ...BASE_HEADERS, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
      body: "Method not allowed",
    };
  }

  const tenant = parseTenantHost(input.host);
  if (!tenant) return textResponse(404, "Not found");

  /**
   * The runtime only serves when the operator has explicitly enabled shared
   * hosting. A deployment that has not opted in must not start serving because
   * a tenant Host reached it.
   */
  if (!isSharedHostingRuntimeEnabled()) {
    return textResponse(404, "Not found");
  }

  const resolved = await resolvePublishedTenant(tenant.hostname);
  if (isHostingStoreFailure(resolved)) {
    logHostingEvent("tenant_error", {
      host: tenant.hostname,
      stage: "resolve",
      code: resolved.code,
    });
    return textResponse(503, "This site is temporarily unavailable.");
  }
  if (!resolved.data) {
    logHostingEvent("tenant_unresolved", { host: tenant.hostname, reason: "not_published" });
    return textResponse(404, "This site is not published.");
  }

  const version = resolved.data;
  const candidates = publishedLookupCandidates(
    input.segments,
    version.entryPath,
    version.spaFallback,
  );
  if (candidates.length === 0) return textResponse(404, "Not found");

  for (const candidate of candidates) {
    const file = await readPublishedFile(tenant.hostname, version.versionId, candidate.path);
    if (isHostingStoreFailure(file)) {
      logHostingEvent("tenant_error", {
        host: tenant.hostname,
        stage: "read",
        code: file.code,
        path: candidate.path,
      });
      return textResponse(503, "This site is temporarily unavailable.");
    }
    if (!file.data) continue;

    logHostingEvent("tenant_served", {
      host: tenant.hostname,
      project: version.projectId,
      version: version.versionId,
      path: file.data.path,
      fallback: candidate.fallback,
      status: 200,
    });

    return {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "content-type": file.data.contentType,
      },
      body: method === "HEAD" ? "" : file.data.content,
    };
  }

  return textResponse(404, "Not found");
}

export type SharedPublicationProbe =
  | { ok: true; version: ResolvedPublishedTenant }
  | { ok: false; reason: "not_resolved" | "entry_missing" | "error"; detail?: string };

/**
 * Prove that Mavly's OWN runtime can serve a just-activated version.
 *
 * This is what "verified" means for a shared publish: the public RPC resolves
 * the hostname to exactly this version and can read its entry document. It does
 * NOT prove DNS, TLS or wildcard routing — those are operator-side and are
 * documented as such. A publish must never claim more than this check proves.
 */
export async function verifySharedPublication(
  hostname: string,
  versionId: string,
): Promise<SharedPublicationProbe> {
  const resolved = await resolvePublishedTenant(hostname);
  if (isHostingStoreFailure(resolved)) {
    return { ok: false, reason: "error", detail: resolved.error };
  }
  if (!resolved.data || resolved.data.versionId !== versionId) {
    return { ok: false, reason: "not_resolved" };
  }

  const entry = await readPublishedFile(hostname, versionId, resolved.data.entryPath);
  if (isHostingStoreFailure(entry)) {
    return { ok: false, reason: "error", detail: entry.error };
  }
  if (!entry.data) return { ok: false, reason: "entry_missing" };

  return { ok: true, version: resolved.data };
}
