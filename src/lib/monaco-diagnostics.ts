"use client";

/**
 * ═══ TURN OFF MONACO'S ERROR MARKERS IN THE CODE PANEL ══════════════════════
 *
 * ⚠️⚠️ EVERY MARKER THIS PANEL COULD SHOW IS A FALSE POSITIVE, and that is the
 * whole justification. Monaco type-checks with its own bundled TypeScript service,
 * against **the single file in the editor and nothing else**. The panel opens one
 * file at a time out of a `git archive`; there is no `tsconfig.json` loaded, no
 * `node_modules`, no sibling modules, no ambient types. So the service reports:
 *
 *   · `Cannot find module 'react'` — and every other import, without exception;
 *   · `Cannot find name 'process' / 'Buffer' / 'JSX'` — no `@types/node`, no lib;
 *   · `Parameter 'x' implicitly has an 'any' type` — the project's real compiler
 *     options are never read, so its actual strictness is unknown;
 *   · `'"…"' can only be default-imported using esModuleInterop` — same reason;
 *   · a syntax error on **every `.tsx` file**, because JSX is not enabled by
 *     default and `<div>` then parses as a type assertion.
 *
 * A file that compiles perfectly in the user's project is shown covered in red.
 * That is not a lint, it is misinformation about their own code — and this panel
 * is a viewer with a save button, not an IDE that could ever have the context to
 * be right.
 *
 * ⚠️ THIS IS *DISPLAY* ONLY AND GATES NOTHING. Saving is unaffected: the write goes
 * to the sandbox, the project's real build runs there, and a genuine error surfaces
 * in the build output and the logs panel — which DO have the whole project.
 *
 * ⚠️ IT MUST RUN IN `beforeMount`. The model is created between `beforeMount` and
 * `onMount`, so configuring diagnostics in `onMount` leaves the first file marked
 * up until something re-validates it.
 *
 * ── WHY THE COMPILER OPTIONS ARE SET ANYWAY ─────────────────────────────────
 *
 * Diagnostics are off, but the same service still drives bracket matching, folding
 * and colouring. Without `jsx: React` the TSX grammar is parsed wrongly and the
 * *highlighting* degrades even with the squiggles gone — so the options are set for
 * the tokeniser's benefit, not the checker's.
 */

/** The shape we use off the `monaco` namespace. Loosely typed on purpose — this
 *  runs against whatever version `@monaco-editor/react` pulled in, and a missing
 *  sub-API must degrade to "one less thing silenced", never to a crash. */
type MonacoLike = {
    languages?: {
        typescript?: {
            typescriptDefaults?: any;
            javascriptDefaults?: any;
            JsxEmit?: Record<string, unknown>;
            ScriptTarget?: Record<string, unknown>;
            ModuleKind?: Record<string, unknown>;
            ModuleResolutionKind?: Record<string, unknown>;
        };
        json?: { jsonDefaults?: any };
        css?: { cssDefaults?: any; scssDefaults?: any; lessDefaults?: any };
    };
};

const OFF = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
};

export function silenceMonacoDiagnostics(monaco: unknown): void {
    const api = monaco as MonacoLike;

    try {
        const ts = api?.languages?.typescript;
        if (!ts) return;

        const compilerOptions = {
            // The tokeniser's settings — see the header. `Preserve` keeps JSX in the
            // tree rather than rewriting it, which is what we want for display.
            jsx: ts.JsxEmit?.Preserve ?? 1,
            target: ts.ScriptTarget?.ESNext ?? 99,
            module: ts.ModuleKind?.ESNext ?? 99,
            moduleResolution: ts.ModuleResolutionKind?.NodeJs ?? 2,
            allowJs: true,
            allowNonTsExtensions: true,
            esModuleInterop: true,
            jsxImportSource: "react",
            // Nothing is being compiled here; asking for lib files we do not have is
            // just more "cannot find" noise from a service that is already muted.
            noLib: true,
            noEmit: true,
        };

        for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
            if (!defaults) continue;
            defaults.setDiagnosticsOptions?.(OFF);
            defaults.setCompilerOptions?.(compilerOptions);
            /**
             * ⚠️ AND STOP IT FETCHING THE FILE'S IMPORTS. Left on, the worker tries
             * to resolve every `import` in the open file — pointless with no
             * `node_modules`, and it is the slowest thing the editor does.
             */
            defaults.setEagerModelSync?.(false);
        }

        /**
         * The other validators have their own switches, and each one produces the
         * same class of false positive:
         *   · JSON — a `tsconfig.json` with comments, or any file with a `$schema`
         *     we cannot fetch, is reported as invalid;
         *   · CSS/SCSS/LESS — every Tailwind at-rule (`@tailwind`, `@apply`,
         *     `@custom-variant`) is an "unknown at rule", so `globals.css` in the
         *     project template lights up on the very first open.
         */
        api.languages?.json?.jsonDefaults?.setDiagnosticsOptions?.({
            validate: false,
            allowComments: true,
            schemaValidation: "ignore",
        });

        for (const defaults of [
            api.languages?.css?.cssDefaults,
            api.languages?.css?.scssDefaults,
            api.languages?.css?.lessDefaults,
        ]) {
            defaults?.setOptions?.({ validate: false });
        }
    } catch (error) {
        // A Monaco version without one of these APIs must not stop the panel opening.
        console.warn(
            "[code] could not silence the editor's diagnostics:",
            error instanceof Error ? error.message : error
        );
    }
}
