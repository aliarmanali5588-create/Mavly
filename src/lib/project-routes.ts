/**
 * ═══ THE ROUTES A PROJECT ACTUALLY SERVES ═══════════════════════════════════
 *
 * Turns the source-archive file list into the list of paths the preview can go
 * to, so the address bar can offer them instead of asking people to remember.
 *
 * ── WHY IT IS DERIVED FROM FILES AND NOT ASKED FOR ──────────────────────────
 *
 * There is no "list my routes" endpoint, and there should not be one: in the App
 * Router the file tree IS the routing table, and the archive that fills the Code
 * panel already contains it. Deriving costs nothing extra and can never disagree
 * with what is deployed.
 *
 * ── ⚠️ THE FIVE APP-ROUTER RULES THAT ARE EASY TO GET WRONG ────────────────
 *
 *  1. **Route groups vanish.** `app/(app)/settings/page.tsx` serves `/settings`,
 *     NOT `/(app)/settings`. Any segment wrapped in parentheses is organisational
 *     and contributes nothing to the URL.
 *  2. **Private folders are not routes.** `_components` and anything else starting
 *     with `_` is excluded from routing by Next itself.
 *  3. **Parallel routes are not navigable.** `@modal` is a slot rendered INTO a
 *     layout; there is no URL that is "the slot".
 *  4. **Only `page` files make a page.** `layout`, `template`, `loading`, `error`,
 *     `not-found` and `route` do not. `route.ts` in particular is an API handler —
 *     real, but not something to put in a preview address bar.
 *  5. **Dynamic segments stay visible as written.** `[id]` cannot be resolved from
 *     the file tree — only the running app knows what ids exist — so it is offered
 *     verbatim and clearly marked. Silently dropping those routes would hide half
 *     of a real app; silently guessing `1` would 404.
 *
 * Pure module: no React, no fetch. Unit-tested by
 * `src/lib/__tests__/project-routes.test.ts`.
 */

export interface ProjectRoute {
    /** The URL path, e.g. `/settings` or `/blog/[slug]`. */
    path: string;
    /**
     * True when the path contains an unresolved segment (`[id]`, `[...slug]`).
     * The picker marks these: clicking one puts a placeholder in the box that the
     * user must replace, so it is never mistaken for a working link.
     */
    dynamic: boolean;
}

/** Files that live in an app directory but do not create a page. */
const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mdx)$/;

/**
 * Find the segments that follow the app directory in a file path.
 *
 * ⚠️ THE ARCHIVE MAY BE PREFIXED. A `git archive` can wrap everything in a
 * top-level folder, and the template keeps its routes under `src/app`, so neither
 * `startsWith("app/")` nor a fixed depth is safe. We look for the LAST `app`
 * segment that is followed by something — the last one, because a project can
 * legitimately contain `src/app/api/app/route.ts`, and the outermost match would
 * then swallow a real route segment.
 */
function segmentsAfterAppDir(filePath: string): string[] | null {
    const parts = filePath.split("/").filter(Boolean);

    for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== "app") continue;
        /**
         * ⚠️ THE WHOLE PREFIX IS CHECKED, NOT JUST THE PARENT. `node_modules/next/app/…`
         * has `next` directly above `app`, so testing only `parts[index - 1]` lets a
         * dependency's own routes into the user's page list.
         */
        if (parts.slice(0, index).some(isExcludedDir)) return null;
        return parts.slice(index + 1);
    }
    return null;
}

/** Directories whose contents are never the user's routes. */
function isExcludedDir(segment: string): boolean {
    return segment === "node_modules" || segment === ".next" || segment === "dist" || segment === "out";
}

/** Pages Router: `pages/about.tsx` → `/about`, `pages/index.tsx` → `/`. */
function segmentsAfterPagesDir(filePath: string): string[] | null {
    const parts = filePath.split("/").filter(Boolean);

    for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] !== "pages") continue;
        // Same reasoning as `segmentsAfterAppDir`.
        if (parts.slice(0, index).some(isExcludedDir)) return null;
        return parts.slice(index + 1);
    }
    return null;
}

function isDynamic(segment: string): boolean {
    return segment.startsWith("[") && segment.endsWith("]");
}

/** `/` for an empty list; otherwise the segments joined. */
function pathFromSegments(segments: string[]): string {
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * ⭐ EVERY PREVIEWABLE PATH IN THE PROJECT, from its file list.
 *
 * Sorted with `/` first and then alphabetically, so the list opens on the one
 * everybody wants and stays stable between renders.
 */
export function routesFromPaths(filePaths: string[]): ProjectRoute[] {
    const found = new Map<string, boolean>();

    for (const filePath of filePaths || []) {
        const parts = filePath.split("/").filter(Boolean);
        const fileName = parts[parts.length - 1] || "";

        // ── App Router ───────────────────────────────────────────────────────
        const appSegments = segmentsAfterAppDir(filePath);
        if (appSegments && PAGE_FILE.test(fileName)) {
            const routeSegments = appSegments.slice(0, -1);

            // Rules 2 and 3: a private folder or a parallel slot anywhere in the
            // chain means this file is not reachable at a URL of its own.
            if (routeSegments.some(segment => segment.startsWith("_") || segment.startsWith("@"))) {
                continue;
            }

            // Rule 1: route groups and intercepting markers contribute nothing.
            const urlSegments = routeSegments.filter(
                segment => !(segment.startsWith("(") && segment.endsWith(")"))
            );

            const path = pathFromSegments(urlSegments);
            found.set(path, urlSegments.some(isDynamic));
            continue;
        }

        // ── Pages Router ─────────────────────────────────────────────────────
        const pageSegments = segmentsAfterPagesDir(filePath);
        if (pageSegments && /\.(tsx|ts|jsx|js|mdx)$/.test(fileName)) {
            const base = fileName.replace(/\.(tsx|ts|jsx|js|mdx)$/, "");

            // `_app`, `_document`, `_error` and the `api` tree are not pages.
            if (base.startsWith("_")) continue;
            if (pageSegments[0] === "api") continue;

            const urlSegments = [...pageSegments.slice(0, -1), ...(base === "index" ? [] : [base])];
            const path = pathFromSegments(urlSegments);
            found.set(path, urlSegments.some(isDynamic));
        }
    }

    return [...found.entries()]
        .map(([path, dynamic]) => ({ path, dynamic }))
        .sort((a, b) => {
            // `/` always leads — it is the one path everyone wants first.
            if (a.path === "/") return -1;
            if (b.path === "/") return 1;
            return a.path.localeCompare(b.path);
        });
}

/**
 * Filter the list against what has been typed.
 *
 * ⚠️ SUBSTRING, NOT PREFIX. People type "sett" meaning `/settings` and "blog"
 * meaning `/blog/[slug]`; a prefix match on the leading slash would find neither
 * unless they typed the slash first, which nobody does.
 */
export function filterRoutes(routes: ProjectRoute[], query: string): ProjectRoute[] {
    const needle = (query || "").trim().toLowerCase().replace(/^\/+/, "");
    if (!needle) return routes;
    return routes.filter(route => route.path.toLowerCase().includes(needle));
}

/**
 * Normalise whatever is in the box into a path.
 *
 * Shared by the address bar's commit and the picker so a typed `settings` and a
 * clicked `/settings` can never produce different values.
 */
export function normalizePath(value: string): string {
    const trimmed = (value || "").trim();
    if (!trimmed || trimmed === "/") return "/";
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
