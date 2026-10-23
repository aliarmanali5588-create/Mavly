"use client";

import * as React from "react";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { filterRoutes, normalizePath, routesFromPaths, type ProjectRoute } from "@/lib/project-routes";
import { peekArchive } from "@/lib/source-archive-cache";
import { vcaasApi } from "@/lib/vcaas";
import { cn } from "@/lib/utils";

/**
 * ═══ THE PREVIEW ADDRESS BAR ════════════════════════════════════════════════
 *
 * The path box and the list of pages the project serves, as ONE combobox: type
 * and the matches appear under the box as you go; press ↓ or the chevron to
 * browse everything.
 *
 * ── ⭐ WHY THE INPUT LIVES IN HERE NOW ──────────────────────────────────────
 *
 * ⚠️ IT USED TO BE A DROPDOWN NEXT TO SOMEBODY ELSE'S TEXT FIELD, and that is
 * why typing did nothing. The input belonged to `PreviewToolbar`, the list lived
 * in this component, and the list only rendered while its own `open` flag was
 * true — so you could type the whole of `/account/settings` and never be shown
 * that it existed unless you first went and clicked the chevron. The two halves
 * of a combobox cannot be two components: the panel has to know what is being
 * typed, the keyboard has to move a selection that lives in the panel, and Enter
 * has to mean "take the highlighted row" in one and "commit what I typed" in the
 * other. Moving the input in is what makes ↑/↓/Enter/Escape possible at all.
 *
 * The toolbar's contract is unchanged: it still owns `path` and still gets
 * `onPathChange` + `onRefresh` in exactly the cases it used to.
 *
 * ── ⭐ IT OPENS THE MOMENT THE BOX IS FOCUSED ────────────────────────────────
 *
 * ⚠️ IT USED TO OPEN ONLY ON A KEYSTROKE, THE CHEVRON, OR ↓ — and that made the
 * whole list a secret. Clicking into the path box showed nothing, so the only way
 * to learn that this project HAS an `/account/settings` page was to already suspect
 * it and start typing the word. A combobox whose panel is closed while the caret is
 * inside it is indistinguishable from a plain text field, which is exactly how it
 * was being used.
 *
 * Focus now opens it in BROWSE mode — the whole list, unfiltered — and the first
 * character switches to filtering (`onChange` clears `browsing`). That ordering is
 * the point: before you type there is no query, so the useful thing to show is
 * everything; from the first letter on, the matches narrow live under the caret.
 *
 * ⚠️ BROWSE, NOT "FILTER BY WHAT IS ALREADY IN THE BOX". The committed path is
 * usually a real page, so filtering on focus would open a panel containing one row
 * — the page you are already looking at — which reads as "there is nothing else".
 *
 * ⚠️ THE CHEVRON HAS TO OPT OUT OF THIS, and `skipFocusOpen` is why. A click on it
 * fires mousedown → focus → click; without the flag, focus would open the panel and
 * the click would immediately toggle it shut, so the chevron could never close
 * anything. See its handler below.
 *
 * ── WHEN IT FETCHES ─────────────────────────────────────────────────────────
 *
 * On FOCUS, once. Not on mount — this renders on every workspace load next to a
 * box most people never touch, and a request for all of them is a lot of traffic
 * for a list nobody asked for. Not on the first keystroke either: the tree takes
 * a moment, and starting it when the caret lands means the matches are already
 * there by the second character instead of arriving after the word is finished.
 *
 * `peekArchive()` is consulted first — if the project's archive is already in
 * memory (someone opened the Code tab this session) that is an answer we have,
 * and it costs not even a request.
 *
 * ⚠️ THE LIST IS FREE. It reads `GET …/files/tree` (the project-files API), not the charged
 * `…/source-code` archive the first version of this had to use. Do not
 * reintroduce a credit gate here.
 *
 * ── NESTED PATHS ────────────────────────────────────────────────────────────
 *
 * `/account/settings` is a route like any other: `routesFromPaths` walks the whole
 * app directory, so any depth appears, and `filterRoutes` matches on a SUBSTRING —
 * typing `settings`, `account/set` or `/account` all find it. Route groups
 * (`(app)`), private folders (`_lib`) and parallel slots (`@modal`) are resolved
 * there too; see that module for the five App-Router rules.
 *
 * ── TYPING ALWAYS WINS ──────────────────────────────────────────────────────
 *
 * This is a companion to the field, never a replacement: the box stays free text,
 * a project whose tree cannot be read behaves exactly as a plain input, and
 * dynamic routes (`/blog/[slug]`) are shown and marked rather than hidden — the
 * file tree cannot know which slugs exist, so picking one puts the placeholder in
 * the box for the user to replace.
 */

export interface PathPickerProps {
    projectId: string;
    /** The committed path. The draft resets to it when it changes from outside. */
    path: string;
    /** Commit a new path. Called on Enter, on blur and on picking a suggestion. */
    onPathChange: (path: string) => void;
    /** Reload the preview. Enter and picking both do this; blur does not. */
    onRefresh: () => void;
    disabled?: boolean;
    className?: string;
}

export function PathPicker({
    projectId,
    path,
    onPathChange,
    onRefresh,
    disabled = false,
    className,
}: PathPickerProps) {
    const t = useT();
    const listboxId = React.useId();

    const [draft, setDraft] = React.useState(path);
    const [open, setOpen] = React.useState(false);
    /**
     * Opened by the chevron rather than by typing: show the WHOLE list, because
     * the intent is "what pages are there", not "narrow what I am writing". Any
     * keystroke drops back to filtering.
     */
    const [browsing, setBrowsing] = React.useState(false);
    const [active, setActive] = React.useState(-1);

    const [routes, setRoutes] = React.useState<ProjectRoute[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    const containerRef = React.useRef<HTMLDivElement>(null);
    const inputRef = React.useRef<HTMLInputElement>(null);

    // Keep the draft in step when the path changes from outside (e.g. a reset).
    React.useEffect(() => setDraft(path), [path]);

    /** Never set state after unmount — the tree request outlives a closed panel. */
    const alive = React.useRef(true);
    React.useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    /** An archive already in memory answers instantly, without a request at all. */
    React.useEffect(() => {
        const cached = peekArchive(projectId);
        setRoutes(cached ? routesFromPaths(cached.paths) : null);
        setFailed(false);
    }, [projectId]);

    /**
     * ⚠️⚠️ IN-FLIGHT STATE IS A REF, NOT A DEPENDENCY, and this is load-bearing.
     * An earlier version kept it in `useState` and listed it in the effect's
     * dependency array, so `setLoading(true)` re-ran the effect, whose cleanup
     * cancelled the request it had just started — the response then hit
     * `if (cancelled) return` and never cleared the spinner. It hung forever, on
     * every open, deterministically. A ref is exactly what "a request is already
     * going" is: something render does not need, and therefore something that
     * must not be able to re-trigger the effect that started it.
     */
    const inFlight = React.useRef(false);

    const load = React.useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;

        setLoading(true);
        setFailed(false);

        try {
            const response = await vcaasApi.files.tree(projectId, { limit: 5000 });
            if (!alive.current) return;

            if (!response.ok || !response.data) {
                setFailed(true);
                return;
            }

            setRoutes(
                routesFromPaths(
                    response.data.entries.filter(e => e.type === "file").map(e => e.path)
                )
            );
        } catch {
            /*
              `proxyRequest` already turns transport failures into `ok: false`, so
              this should be unreachable — which is exactly why it is here. The one
              thing this component must never do again is leave the spinner up
              because a code path forgot to clear it.
            */
            if (alive.current) setFailed(true);
        } finally {
            inFlight.current = false;
            if (alive.current) setLoading(false);
        }
    }, [projectId]);

    /** Called on focus and by the retry button. Cheap and idempotent. */
    const ensureRoutes = React.useCallback(() => {
        if (routes || loading || failed || inFlight.current) return;
        void load();
    }, [routes, loading, failed, load]);

    /**
     * ⚠️ "THIS NEXT FOCUS IS ONE *WE* CAUSED — do not open on it."
     *
     * Set by the chevron before it moves focus into the input. Without it the
     * chevron's own click would be undone by the focus handler and the panel could
     * never be closed with it. Cleared by whichever handler consumes it, and again
     * on blur so a chevron press that did not move focus (the input was already
     * focused) cannot swallow the NEXT genuine focus.
     */
    const skipFocusOpen = React.useRef(false);

    /**
     * ⭐ FOCUS OPENS THE LIST. The reason this exists at all is at the top of the
     * file; the shape here is just "load, then show everything".
     */
    const openFromFocus = React.useCallback(() => {
        ensureRoutes();
        if (skipFocusOpen.current) {
            skipFocusOpen.current = false;
            return;
        }
        setBrowsing(true);
        setOpen(true);
    }, [ensureRoutes]);

    // Close on an outside click — the usual combobox contract. Escape is handled
    // on the input itself, where it also has to be able to revert the draft.
    React.useEffect(() => {
        if (!open) return;

        function onPointerDown(event: MouseEvent | TouchEvent) {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        }

        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [open]);

    const matches = React.useMemo(() => {
        if (!routes) return [];
        return browsing ? routes : filterRoutes(routes, draft);
    }, [routes, browsing, draft]);

    /*
      ⚠️ THE HIGHLIGHT IS RESET WHENEVER THE LIST CHANGES. Keeping index 3 while
      the list shrinks to two rows would leave Enter pointing at nothing — or, far
      worse, silently at a different page than the one under the highlight.
    */
    React.useEffect(() => setActive(-1), [matches]);

    function commit(value: string): string {
        // ⚠️ ONE normaliser, shared with every entry point, so a typed `settings`
        // and a clicked `/settings` can never produce different values.
        const normalised = normalizePath(value);
        setDraft(normalised);
        if (normalised !== path) onPathChange(normalised);
        return normalised;
    }

    /** Picking is a commit AND a navigation — clicking `/` while on `/` reloads. */
    function pick(next: string) {
        commit(next);
        onRefresh();
        setOpen(false);
        setBrowsing(false);
        inputRef.current?.focus();
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            // ↓ on a closed box is "show me the pages" — the standard combobox
            // shortcut, and the only one that does not require reaching for a mouse.
            if (!open) {
                event.preventDefault();
                setBrowsing(true);
                setOpen(true);
                ensureRoutes();
                return;
            }
            if (matches.length === 0) return;

            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive(current => {
                const next = current + step;
                // Wraps, so ↑ from the box goes straight to the last match.
                if (next < 0) return matches.length - 1;
                if (next >= matches.length) return 0;
                return next;
            });
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            // The highlighted row wins; otherwise Enter means what it always meant.
            if (open && active >= 0 && matches[active]) {
                pick(matches[active].path);
                return;
            }
            commit(draft);
            setOpen(false);
            onRefresh();
            return;
        }

        if (event.key === "Escape") {
            // First Escape dismisses the suggestions, second reverts the edit —
            // so dismissing the list never also throws away what was typed.
            if (open) {
                setOpen(false);
                setBrowsing(false);
                return;
            }
            setDraft(path);
            event.currentTarget.blur();
            return;
        }

        if (event.key === "Tab") setOpen(false);
    }

    const showPanel = open && !disabled;

    return (
        <div ref={containerRef} className={cn("relative flex min-w-0 flex-1 items-center", className)}>
            <label htmlFor="preview-path" className="sr-only">
                {t("workspace.preview.pathLabel")}
            </label>
            <input
                id="preview-path"
                ref={inputRef}
                value={draft}
                disabled={disabled}
                role="combobox"
                aria-expanded={showPanel}
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={
                    showPanel && active >= 0 ? `${listboxId}-option-${active}` : undefined
                }
                onFocus={openFromFocus}
                onChange={event => {
                    setDraft(event.target.value);
                    // ⭐ THE POINT OF ALL THIS: matches appear as the characters do.
                    setBrowsing(false);
                    setOpen(true);
                }}
                onBlur={() => {
                    /*
                      ⚠️ THE PANEL IS NOT CLOSED HERE. A click on a suggestion blurs
                      the input before it fires, so closing on blur would unmount the
                      row mid-click and the pick would be lost. The options call
                      `preventDefault` on mousedown to keep focus in the box, and the
                      outside-click listener closes the panel for every other case.
                    */
                    // A pending "don't open on the next focus" cannot outlive the
                    // focus it was meant for — see `skipFocusOpen`.
                    skipFocusOpen.current = false;
                    commit(draft);
                }}
                onKeyDown={handleKeyDown}
                placeholder="/"
                spellCheck={false}
                autoComplete="off"
                className="text-muted-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 bg-transparent px-1 font-mono text-xs focus:outline-none disabled:opacity-60"
            />

            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                disabled={disabled}
                tabIndex={-1}
                aria-hidden
                /*
                  ⚠️ `onMouseDown`, NOT `onClick`, AND IT PREVENTS DEFAULT. Now that
                  focus opens the panel, a plain click handler ran AFTER the browser
                  had already focused the input and opened it — so the toggle read
                  `open === true` and closed something the user had just asked to see,
                  or (from an unfocused box) opened and instantly closed it. Handling
                  mousedown lets us decide from the state BEFORE the focus, and
                  `preventDefault` stops the browser moving focus behind our back;
                  `skipFocusOpen` covers the focus we then move ourselves.
                */
                onMouseDown={event => {
                    event.preventDefault();
                    const next = !open;
                    skipFocusOpen.current = true;
                    setOpen(next);
                    if (next) {
                        setBrowsing(true);
                        ensureRoutes();
                    }
                    inputRef.current?.focus();
                }}
            >
                <ChevronDownIcon
                    className={cn("size-3.5 transition-transform", showPanel && "rotate-180")}
                    aria-hidden
                />
            </Button>

            {showPanel ? (
                <div
                    id={listboxId}
                    role="listbox"
                    aria-label={t("workspace.preview.pagesLabel")}
                    className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1.5 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border p-1 shadow-md"
                >
                    {loading && routes === null ? (
                        <div className="text-muted-foreground flex items-center gap-2 p-2 text-xs">
                            <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                            {t("common.loading")}
                        </div>
                    ) : failed && routes === null ? (
                        <div className="space-y-2 p-2">
                            <p className="text-destructive text-xs">
                                {t("workspace.preview.pagesFailed")}
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="w-full"
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => {
                                    setFailed(false);
                                    void load();
                                }}
                            >
                                {t("workspace.preview.pagesRetry")}
                            </Button>
                        </div>
                    ) : matches.length === 0 ? (
                        <p className="text-muted-foreground p-2 text-xs">
                            {t("workspace.preview.pagesNoMatch")}
                        </p>
                    ) : (
                        <ul className="space-y-0.5">
                            {matches.map((route, index) => (
                                <li key={route.path}>
                                    <button
                                        type="button"
                                        role="option"
                                        id={`${listboxId}-option-${index}`}
                                        aria-selected={index === active}
                                        className={cn(
                                            "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left font-mono text-xs focus-visible:outline-none",
                                            index === active ? "bg-accent" : "hover:bg-accent/60"
                                        )}
                                        // Keeps focus (and therefore the draft) in the
                                        // input so `onBlur`'s commit cannot beat this click.
                                        onMouseDown={event => event.preventDefault()}
                                        onMouseEnter={() => setActive(index)}
                                        onClick={() => pick(route.path)}
                                    >
                                        <span className="truncate">{route.path}</span>
                                        {/*
                                          ⚠️ MARKED, NOT HIDDEN. `[slug]` is a real
                                          route whose values only the running app
                                          knows. Showing it with a badge is honest;
                                          dropping it would hide half of a blog.
                                        */}
                                        {route.dynamic ? (
                                            <span className="text-muted-foreground bg-muted shrink-0 rounded px-1 py-px font-sans text-[10px]">
                                                {t("workspace.preview.pagesDynamic")}
                                            </span>
                                        ) : null}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : null}
        </div>
    );
}
