import { NextResponse } from "next/server";
import { isRoutableProjectSlug } from "@/lib/project-slug";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

export { isRoutableProjectSlug };

/**
 * ═══ THE REAL ROUTE GUARDS (F-2) — SESSION + OWNERSHIP ═════════════════════
 *
 * ⚠️⚠️ THIS FILE USED TO BE TWO DOCUMENTED NO-OPS ("the key is the whole
 * identity"; "always allows"). Deployed with a login in front, every signed-in
 * user reached every project the account-wide Totalum key could reach. It is
 * now the single place that answers the platform's two original questions for
 * real:
 *
 *   1. `resolveVcaasContext()`  — WHO IS ASKING?  A Supabase session, verified
 *      by `getUser()` against the Auth server. The user id comes from that
 *      answer and from nowhere else — never from a URL, a body, a header, or
 *      anything upstream sent back. No service-role key is involved: the
 *      caller's own anon-key session client is the whole credential.
 *
 *   2. `enforceProjectScope()`  — MAY THEY TOUCH THIS PROJECT?  A row in
 *      `public.projects` (migration 02) for (project_id, user_id), read
 *      THROUGH THE CALLER'S OWN CLIENT so the table's RLS policies are the
 *      boundary. Owner → allow. Anyone else, or no record at all → 403 with an
 *      identical body, so the answer never discloses whether somebody else's
 *      project exists. Supabase unreachable → fail CLOSED (500), never open.
 *
 * The shape of both signatures is kept from totalum-platform so the copied
 * routes (`/api/preview/*`, `/api/visual-edit/*`) compile with `await` and
 * without semantic surprises; `team` now carries the verified `userId` the
 * ownership check needs.
 *
 * ⚠️ WIRED EVERYWHERE PROJECT-SCOPED. The catch-all classifies each upstream
 * path (`src/lib/vcaas-scope.ts`) and calls `checkProjectAccess` for the
 * project ones; `upload`, `source-code`, `git-diff`, `preview` and
 * `visual-edit` call `authorizeProjectRequest`/`enforceProjectScope` before they
 * touch upstream. Account-level endpoints are explicitly allowlisted, and an
 * unknown path is refused rather than forwarded.
 */

/** What `resolveVcaasContext` passes to upstream calls: the verified caller. */
export interface VcaasContext {
    /** The Supabase user id — used as the per-caller key (e.g. origin cache). */
    accountUserId?: string;
}

/** The platform's actor context; here it is exactly the verified user. */
export interface VcaasTeam {
    userId: string;
}

export interface VcaasAuthOk {
    ok: true;
    ctx: VcaasContext;
    team: VcaasTeam;
}

export type VcaasAuthResult = VcaasAuthOk | { ok: false; response: NextResponse };

export type VcaasAuthFailed = Extract<VcaasAuthResult, { ok: false }>;

export function authFailed(result: VcaasAuthResult): result is VcaasAuthFailed {
    return result.ok === false;
}

/**
 * THE INTENTIONAL DISCONNECTION RESPONSE.
 *
 * The upstream Totalum VCaaS integration has been removed from the active
 * runtime. Every route that used to forward to it keeps its session and
 * ownership checks, then answers this instead — a truthful 503, never a
 * fabricated success and never a request to a non-existent backend.
 *
 * The body follows the app's `{ ok:false, error, code, data }` envelope so the
 * existing UI error paths render it like any other failed call.
 */
export function backendNotConfigured(): NextResponse {
    return NextResponse.json(
        {
            ok: false,
            error: "The Mavly backend is not implemented yet.",
            code: "BACKEND_NOT_CONFIGURED",
            data: null,
        },
        {
            status: 503,
            headers: { "cache-control": "private, no-store, max-age=0" },
        },
    );
}

/** The shape of "a user this resolver could VERIFY" — `id` is all we use. */
type SessionUser = { id: string } | null;
type UserResolver = () => Promise<SessionUser>;

/**
 * The one 401 this module produces. JSON (this runs inside route handlers, not
 * the proxy), `no-store` because an auth refusal must never be replayed from
 * a cache. The body mirrors the app's `{ ok:false, error, code }` envelope so
 * the client layer renders it like any other API failure.
 */
function unauthenticated(): VcaasAuthFailed {
    return {
        ok: false,
        response: NextResponse.json(
            { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" },
            { status: 401, headers: { "cache-control": "private, no-store, max-age=0" } },
        ),
    };
}

/**
 * WHO IS ASKING? — `getUser()` verifies the token with the Auth server; an
 * expired, tampered or revoked session answers null, never a user.
 *
 * The default resolver is the repository's established `getCurrentUser`
 * (`src/lib/supabase/server.ts`). The parameter is a test seam: tests inject a
 * resolver instead of standing up an Auth server. Production call sites pass
 * nothing and get the real one.
 */
export async function resolveVcaasContext(resolveUser: UserResolver = getCurrentUser): Promise<VcaasAuthResult> {
    const user = await resolveUser();
    if (!user) return unauthenticated();
    return {
        ok: true,
        ctx: { accountUserId: user.id },
        team: { userId: user.id },
    };
}

/**
 * How `enforceProjectScope` reads `public.projects`. Exported so tests can
 * stub it; production callers never pass it.
 *
 *   · "owned"     — a row exists for (userId, projectId) *as visible through
 *                   the caller's own RLS-scoped client*
 *   · "not-owned" — no such row (either the project belongs to someone else or
 *                   no ownership record exists — deliberately indistinguishable)
 *   · "error"     — the lookup could not complete (Supabase unreachable,
 *                   table missing, session client unavailable). FAIL CLOSED.
 */
export type OwnershipAnswer = "owned" | "not-owned" | "error";
export type OwnershipLookup = (userId: string, projectId: string) => Promise<OwnershipAnswer>;

/**
 * The real lookup: the caller's own anon-key session client, so the RLS
 * policies from migration 02 are the access boundary — this code never gets a
 * privileged client, and there is no service-role key in this app to misuse.
 *
 * `.eq("user_id", userId)` is belt-and-braces: RLS already scopes rows to
 * `auth.uid()`, and userId comes from the same session, but stating the
 * predicate makes the intended guarantee readable at the call site.
 *
 * ⚠️ AN ERROR HERE IS NEVER "ALLOW". PostgREST answers an RLS-filtered miss
 * with an empty result (that is "not-owned"), so anything in `error` is a real
 * failure — logged WITHOUT the query, cookies, or any credential, and mapped
 * to "error" → 500 by the caller.
 */
const rlsOwnershipLookup: OwnershipLookup = async (userId, projectId) => {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return "error"; // Supabase not configured — cannot verify anything

    const { data, error } = await supabase
        .from("projects")
        .select("project_id")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .limit(1);

    if (error) {
        console.error("[vcaas] ownership lookup failed:", error.message);
        return "error";
    }
    return (data?.length ?? 0) > 0 ? "owned" : "not-owned";
};

/**
 * Literal (non-parameter) segments the Totalum API serves UNDER
 * `/projects/{id}` — `POST /projects/launch` (create + first prompt) and
 * `GET /projects/credit-limits/at-limit`. They are catalogued in
 * `src/lib/vcaas.ts` (search `projects/launch`), and the method is part of the
 * identity: `POST /projects/launch` is the launch action, while
 * `GET /projects/launch` would be a real get of a project that happens to be
 * named "launch" and MUST go through the ownership check.
 *
 * ⚠️ KEEP THIS IN STEP WITH `vcaas.ts`. When a new literal path is catalogued
 * there, add it here — until then a request for such a path would be treated
 * as a project id and answered 403, which fails closed (a broken feature, not
 * a hole).
 */
const PROJECT_ACTION_SEGMENTS: ReadonlyArray<{ method: string; segment: string }> = [
    { method: "POST", segment: "launch" },
    { method: "GET", segment: "credit-limits" },
];

function isProjectAction(method: string, segment: string): boolean {
    const verb = method.toUpperCase();
    return PROJECT_ACTION_SEGMENTS.some((a) => a.method === verb && a.segment === segment);
}

/** 400 — the segment that should name a project is not a routable slug. */
function invalidProject(): NextResponse {
    return NextResponse.json(
        { ok: false, error: "Invalid project", code: "VALIDATION" },
        { status: 400 },
    );
}

/**
 * 403 — not the owner. ⚠️ THE SAME BODY FOR "belongs to someone else" AND FOR
 * "no ownership record": one answer for both, so the response cannot be used
 * to test which project ids exist.
 */
function forbidden(): NextResponse {
    return NextResponse.json(
        { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" },
        { status: 403, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
}

/** 500 — the ownership question could not be answered. Fail closed. */
function ownershipCheckFailed(): NextResponse {
    return NextResponse.json(
        { ok: false, error: "We couldn't verify access to this project. Please try again.", code: "UNKNOWN" },
        { status: 500, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
}

/**
 * MAY THIS CALLER TOUCH THIS PROJECT? — the one project-id check every route
 * uses, whatever shape its path has.
 *
 * `null` means yes. A malformed id is 400 without a lookup; a missing/foreign
 * row is the same non-enumerating 403; a failed lookup is 500 (fail closed).
 */
export async function checkProjectAccess(
    team: VcaasTeam,
    projectId: string,
    lookup: OwnershipLookup = rlsOwnershipLookup,
): Promise<NextResponse | null> {
    if (!isRoutableProjectSlug(projectId)) return invalidProject();

    const answer = await lookup(team.userId, projectId);
    if (answer === "owned") return null;
    if (answer === "error") return ownershipCheckFailed();
    return forbidden();
}

/**
 * THE ROUTE-HANDLER SHORTCUT: authenticate, then check ownership of `projectId`.
 *
 * The dedicated non-catch-all routes (`upload`, `source-code`, `git-diff`)
 * use this so there is exactly one order of operations: the verified
 * session first (401), then the project row (400/403/500) — and only then any
 * upstream request or file read.
 */
export type ProjectAuthorization =
    | { ok: true; team: VcaasTeam }
    | { ok: false; response: NextResponse };

export async function authorizeProjectRequest(
    projectId: string,
    deps: {
        resolveUser?: UserResolver;
        lookup?: OwnershipLookup;
    } = {},
): Promise<ProjectAuthorization> {
    const auth = await resolveVcaasContext(deps.resolveUser);
    if (authFailed(auth)) return { ok: false, response: auth.response };

    const denial = await checkProjectAccess(auth.team, projectId, deps.lookup);
    if (denial) return { ok: false, response: denial };
    return { ok: true, team: auth.team };
}

/**
 * MAY THIS CALLER TOUCH THIS PATH? — `null` means yes (continue as before);
 * a response means no (return it unchanged, as both existing call sites do).
 *
 * How the path is read, in order:
 *
 *   · `path[0] !== "projects"`            → account-scoped path (`webhooks`,
 *     `domains`, `account`, …): there is no project id here to check, so it
 *     is never mistaken for one. Allow (the session gate already ran).
 *   · no `path[1]` (list/create `projects`) → likewise no id in the path. Allow.
 *   · `path[1]` is a known ACTION segment for this method (`launch`,
 *     `credit-limits`) → not an id. Allow.
 *   · `path[1]` is not a routable slug      → 400 (this is a malformed path,
 *     never a lookup — see `isRoutableProjectSlug`).
 *   · otherwise                             → the ownership lookup decides:
 *     "owned" → null, "not-owned" → 403, "error" → 500 (closed).
 *
 * `method` selects among the action segments above. The `lookup` parameter is
 * a test seam (defaults to the RLS read); production call sites pass only the
 * platform's three arguments.
 */
export async function enforceProjectScope(
    team: VcaasTeam,
    method: string,
    path: string[],
    lookup: OwnershipLookup = rlsOwnershipLookup,
): Promise<NextResponse | null> {
    if (path[0] !== "projects") return null;      // account-scoped: no project id in the path
    const segment = path[1];
    if (!segment) return null;                    // `/projects` list/create: no id in the path
    if (isProjectAction(method, segment)) return null; // `POST projects/launch` etc.: not an id
    return checkProjectAccess(team, segment, lookup);
}
