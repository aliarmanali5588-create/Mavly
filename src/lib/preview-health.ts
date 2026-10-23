/**
 * ═══ IS THE PREVIEW ACTUALLY SHOWING THE USER'S APP? ════════════════════════
 *
 * The pure half — no fetch, no React, no DOM. It answers one question about a
 * string of HTML: is this the project, or is it wreckage?
 *
 * ⚠️⚠️ A FALSE POSITIVE IS MUCH WORSE THAN A FALSE NEGATIVE, and that governs
 * every threshold here. Telling someone their working app is broken — while they
 * are looking at it working — destroys trust in every warning we ever show. Saying
 * nothing about a genuinely broken preview costs one confused minute. So every
 * check below requires SEVERAL independent signals to agree, and anything
 * ambiguous is reported as healthy.
 *
 * Unit-tested by `src/lib/__tests__/preview-health.test.ts`.
 */

export type PreviewVerdict =
    /** The document looks like a real, working page. */
    | "ok"
    /** The sandbox served its own "building, expired or broken" placeholder. */
    | "placeholder"
    /** A real document whose stylesheet and script are both unreachable. */
    | "assets-missing"
    /**
     * ⭐ THE HTML PAINTS AND NOTHING ELSE DOES. The document is real and its
     * stylesheet is being served, but every one of the app's own script chunks is
     * refused — so the browser renders the server-sent markup and then stops. The
     * page looks *almost* right, which is what makes this the worst one to leave
     * undetected: no hydration, no state, no handlers, no client components. Every
     * button is a dead rectangle.
     *
     * ⚠️ THIS IS THE `crate-simple-landing` FAILURE, and it is a REAL, REPRODUCED
     * one, not a hypothetical. Its sandbox was archived; the document kept coming
     * back 200 from an edge cache while every `/_next/static/**` request answered
     * **503**. `assets-missing` could not name it, because that verdict requires
     * the stylesheet to fail too — and here it does not always. See the note on
     * `MIN_DEAD_SCRIPTS` for why several dead scripts, not one, are demanded.
     */
    | "scripts-dead";

/**
 * The placeholder the sandbox serves when the app is not up.
 *
 * ⚠️ IT IS TINY, AND THAT IS THE STRONGEST SIGNAL WE HAVE. The known page is about
 * 500 characters. A real generated app — Next.js, with its inlined flight payload,
 * preload hints and font links — is tens of kilobytes before its content even
 * starts. Nothing real is this small, so the length check alone rules out almost
 * every page in existence, and the text markers then confirm which one this is.
 *
 * The ceiling is deliberately generous against the known 500: the placeholder is
 * served by infrastructure we do not control (note the `cf-error-details` div —
 * Cloudflare appends to it), so it may grow. 4 KB still cannot be an app.
 */
export const PLACEHOLDER_MAX_HTML_LENGTH = 4000;

/**
 * Distinctive fragments of that page.
 *
 * ⚠️ MATCHED CASE-INSENSITIVELY AND WITH WHITESPACE COLLAPSED, because this HTML
 * reaches us through a proxy and may be re-indented or minified on the way.
 *
 * ⚠️ THE ANIMATION AND THE LAYOUT STYLE ARE HERE ON PURPOSE, not just the prose.
 * The wording is the part most likely to be reworded upstream; the keyframe name
 * and the `place-items:center` body are structural and survive a copy edit. Any
 * TWO of these, in a document that is already impossibly small, is conclusive.
 */
export const PLACEHOLDER_MARKERS = [
    "preview building, expired or broken",
    "tell the ai to rebuild your app",
    "@keyframes s{to{transform:rotate(1turn)}}",
    "place-items:center",
    "cf-error-details",
] as const;

/** How many markers must agree. Two, in a sub-4 KB document. */
export const PLACEHOLDER_MIN_MARKERS = 2;

function normalise(html: string): string {
    return html.replace(/\s+/g, " ").toLowerCase();
}

export function countPlaceholderMarkers(html: string): number {
    // The markers are written without spaces where the source has none; collapsing
    // whitespace in BOTH makes the comparison indifferent to formatting.
    const haystack = normalise(html).replace(/\s/g, "");
    let hits = 0;
    for (const marker of PLACEHOLDER_MARKERS) {
        if (haystack.includes(marker.replace(/\s/g, ""))) hits++;
    }
    return hits;
}

/**
 * ⭐ THE SANDBOX PLACEHOLDER, IDENTIFIED BY THREE INDEPENDENT THINGS AT ONCE:
 * it is impossibly small, it has no application markup in it, and at least two of
 * its distinctive fragments are present.
 */
export function looksLikePlaceholder(html: string): boolean {
    if (html.length > PLACEHOLDER_MAX_HTML_LENGTH) return false;
    // A real app — however broken — ships script tags. The placeholder ships none.
    if (/<script[\s>]/i.test(html)) return false;
    return countPlaceholderMarkers(html) >= PLACEHOLDER_MIN_MARKERS;
}

/**
 * ⚠️ OUR OWN INJECTED SCRIPT IS NOT THE APP'S. The preview proxy adds the visual
 * editor's agent to every document it serves, and it is the FIRST script tag in the
 * head — so a naive "first script" picks up a file that belongs to the platform,
 * not to the project. Whether it loads says nothing about the user's build, and it
 * is legitimately absent when the editor is not running. It is marked with its own
 * attribute precisely so it can be told apart.
 */
const INJECTED_SCRIPT_MARKER = "data-totalum-visual-editor";

/**
 * The first stylesheet and the first script **the app itself** asks for.
 *
 * ⚠️ ONLY SAME-ORIGIN, ROOT-ABSOLUTE URLS. A `<script src="https://analytics…">`
 * that fails says nothing about whether the app works, and probing a third party
 * from the user's session is not ours to do. `/_next/...` is what matters.
 */
/** ⚠️ ONLY SAME-ORIGIN, ROOT-ABSOLUTE URLS — see `appAssets`. */
function localOnly(value: string | undefined | null): string | null {
    return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/**
 * How many of each the caller should probe.
 *
 * ⚠️ EVERY ONE OF THESE IS A REQUEST TO THE USER'S SANDBOX, on a timer, for every
 * open workspace. Three scripts and one stylesheet is four — enough that "all of
 * them are refused" is a fact rather than a coincidence, few enough that the poll
 * stays cheap. Do not raise these without a reason that is worth the traffic.
 */
export const MAX_PROBED_SCRIPTS = 3;
export const MAX_PROBED_STYLES = 1;

/**
 * ⚠️⚠️ HOW MANY DEAD SCRIPTS BEFORE WE ARE ALLOWED TO SAY `scripts-dead`. **Two.**
 *
 * ONE unreachable chunk is an ordinary event: a cache miss, a chunk renamed by a
 * rebuild that landed between the document and the probe, an ad blocker, a dropped
 * packet. Calling that "your app is broken" is precisely the cry-wolf failure this
 * whole module exists to avoid.
 *
 * TWO independent chunks, both refused, in one pass, confirmed by a second pass six
 * seconds later, is not a coincidence — it is a build that is not being served. And
 * a document that ships only ONE script can never reach this verdict at all, which
 * is the correct outcome: with a single data point there is nothing to corroborate.
 */
export const MIN_DEAD_SCRIPTS = 2;

/**
 * The stylesheets and scripts **the app itself** asks for, in document order.
 *
 * ⚠️ ONLY SAME-ORIGIN, ROOT-ABSOLUTE URLS. A `<script src="https://analytics…">`
 * that fails says nothing about whether the app works, and probing a third party
 * from the user's session is not ours to do. `/_next/...` is what matters.
 *
 * ⚠️ THE PROXY'S OWN INJECTED AGENT IS EXCLUDED — see `INJECTED_SCRIPT_MARKER`.
 */
export function appAssets(html: string): { styles: string[]; scripts: string[] } {
    const styles: string[] = [];
    for (const match of html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)) {
        const href = localOnly(/href=["']([^"']+)["']/i.exec(match[0])?.[1]);
        if (href && !styles.includes(href)) styles.push(href);
        if (styles.length >= MAX_PROBED_STYLES) break;
    }

    const scripts: string[] = [];
    for (const match of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi)) {
        if (match[0].includes(INJECTED_SCRIPT_MARKER)) continue;
        const src = localOnly(match[1]);
        if (src && !scripts.includes(src)) scripts.push(src);
        if (scripts.length >= MAX_PROBED_SCRIPTS) break;
    }

    return { styles, scripts };
}

/**
 * The first stylesheet and the first script the app itself asks for.
 *
 * Kept as the single-asset view over `appAssets`, because "what is the app's own
 * first script" is asked in more than one place and the answer must not drift.
 */
export function firstAssets(html: string): { style: string | null; script: string | null } {
    const { styles, scripts } = appAssets(html);
    return { style: styles[0] ?? null, script: scripts[0] ?? null };
}

/**
 * ⚠️⚠️⚠️ DO NOT REINTRODUCE "ARCHIVED ⇒ THE PREVIEW IS DEAD". IT IS NOT TRUE, AND
 * IT WAS MEASURED TO BE UNTRUE.
 *
 * The temptation is strong, because probing a sleeping sandbox is the slowest thing
 * this module does (~3 s per request, so ~15 s for a verdict) and `agentServerStatus`
 * is sitting right there on the project record, free. A `looksAsleep()` shortcut was
 * built on exactly that reasoning and shipped as an "instant verdict".
 *
 * ⭐ IT WAS WRONG ON 5 OF THE 5 REAL PROJECTS IT WAS TESTED AGAINST. Every one had
 * `agentServerStatus: "Archived"` and was pointed at its LIVE url, and every one was
 * serving a completely healthy app — document 200 AND all four assets 200. Archiving
 * the VM evidently does not stop that hostname serving. So the shortcut threw a
 * "your server is asleep" overlay over five working previews, instantly and with no
 * evidence whatsoever — the precise failure the doctrine at the top of this file
 * exists to prevent, committed in the name of saving thirteen seconds.
 *
 * ⚠️ THERE IS NO SHORTCUT, BECAUSE THE TWO CASES ARE INDISTINGUISHABLE WITHOUT THE
 * NETWORK. A dead preview and a live one both answer the document with 200; the ONLY
 * thing that separates them is whether `/_next/static/**` is served. That has to be
 * asked, and asking it is what costs the seconds.
 */

/**
 * ⭐ THE VERDICT.
 *
 * `assetsReachable` is supplied by the caller, which is the only part that needs
 * the network: `null` means "not checked / could not tell", and is treated as
 * healthy for the reason at the top of this file.
 *
 * ⚠️ A DOCUMENT WITH NO LOCAL ASSETS AT ALL IS NOT REPORTED BROKEN. A hand-written
 * static page with inline styles is perfectly valid, and we cannot distinguish it
 * from a stripped one. Only a page that ASKS for a stylesheet or a script and is
 * refused both counts.
 */
export function classifyPreview({
    html,
    assetsReachable,
    scriptsReachable = null,
}: {
    html: string;
    /** Did ANY probed asset — stylesheet or script — answer? */
    assetsReachable: boolean | null;
    /**
     * Did ANY probed **script** answer? Supplied separately from `assetsReachable`
     * because the interesting failure is asymmetric: a page whose CSS loads and
     * whose JS does not renders, and looks nearly right, and does nothing.
     * `null` ⇒ not checked / could not tell ⇒ healthy.
     */
    scriptsReachable?: boolean | null;
}): PreviewVerdict {
    if (looksLikePlaceholder(html)) return "placeholder";

    const { styles, scripts } = appAssets(html);
    if (styles.length === 0 && scripts.length === 0) return "ok";

    // Nothing at all is being served. The most complete statement, so it wins.
    if (assetsReachable === false) return "assets-missing";

    /**
     * ⭐ THE HTML IS SERVED AND THE JAVASCRIPT IS NOT.
     *
     * ⚠️ GATED ON `MIN_DEAD_SCRIPTS` — read the note there before touching this.
     * A document that ships one script can never reach this verdict.
     */
    if (scriptsReachable === false && scripts.length >= MIN_DEAD_SCRIPTS) {
        return "scripts-dead";
    }

    return "ok";
}
