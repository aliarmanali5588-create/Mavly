import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
    authFailed,
    backendNotConfigured,
    enforceProjectScope,
    isRoutableProjectSlug,
    resolveVcaasContext,
} from "../../../vcaas/_shared";

export const dynamic = "force-dynamic";

/**
 * `POST /api/visual-edit/{projectId}/apply` — INTENTIONALLY DISCONNECTED.
 *
 * Applying a visual change used to read the project's file tree and source,
 * write the edited files and start a rebuild through the Totalum VCaaS API.
 * That upstream integration has been removed and there is no local replacement
 * yet, so this route writes nothing.
 *
 * The authorization chain is unchanged: verified session first (401), then the
 * owner check against `public.projects` (400/403/500). Only then does the route
 * answer the explicit `BACKEND_NOT_CONFIGURED` 503. A failure here is honest:
 * the editor must not report an edit as saved when no file was touched.
 */
export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const auth = await resolveVcaasContext();
    if (authFailed(auth)) return auth.response;

    const { projectId } = await params;
    if (!isRoutableProjectSlug(projectId)) {
        return NextResponse.json(
            { ok: false, code: "PROJECT_NOT_FOUND", error: "PROJECT_NOT_FOUND" },
            { status: 404 }
        );
    }

    const outOfScope = await enforceProjectScope(auth.team, "POST", ["projects", projectId]);
    if (outOfScope) return outOfScope;

    return backendNotConfigured();
}
