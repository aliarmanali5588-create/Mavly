/**
 * ═══ TENANT RESPONSE ROUTE (INTERNAL) ═══════════════════════════════════════
 *
 * `src/proxy.ts` rewrites every request on a validated tenant host to this path,
 * preserving the browser URL and the `Host` header. The handler then resolves
 * the tenant from the host alone.
 *
 * ⚠️ REACHING THIS PATH DIRECTLY DOES NOTHING. On the app's own host, the proxy
 * runs the normal API gate (401 for a signed-out caller), and the handler's own
 * host parser refuses `mavly.xyz`, `www.mavly.xyz`, localhost and every non
 * tenant host with a 404. There is no `?projectId=` fallback by design.
 */

import type { NextRequest } from "next/server";

import { serveTenantRequest } from "@/lib/hosting/serve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await context.params;

  const result = await serveTenantRequest({
    host: request.headers.get("host"),
    segments: path,
    method: request.method,
  });

  return new Response(request.method === "HEAD" ? null : result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export const GET = handle;
export const HEAD = handle;
