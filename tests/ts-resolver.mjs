/**
 * A tiny module resolver for the tests.
 *
 * The source files use bundler-style imports (`import … from "./redirect"`),
 * which Next.js and TypeScript resolve but Node's ESM loader does not: Node
 * wants an extension. This hook falls back to `<specifier>.ts` when the
 * extensionless specifier cannot be found, so `node --test` can load the real
 * application modules without touching their imports.
 *
 * It also resolves the path alias the source uses (`@/lib/…` → `src/lib/…`),
 * so tests can import the real `src/proxy.ts` and its imports exactly as the
 * bundler would. Without this, any test that pulls a file with an `@/` import
 * fails to load — which is why `routes.test.ts` reads `proxy.ts` as text
 * instead. Alias resolution is tried with the extension first (a few imports
 * are written explicitly), then with the `.ts` fallback.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const SRC_ROOT = pathToFileURL(resolvePath(dirname(fileURLToPath(import.meta.url)), "../src")).href
  .replace(/\/$/, "");

async function withFallbacks(target, context, nextResolve) {
  try {
    return await nextResolve(target, context);
  } catch {
    // `.ts` for our extensionless source imports…
    try {
      return await nextResolve(`${target}.ts`, context);
    } catch {
      // …and `.js` for package subpaths without an exports map (`next/server`
      // ships only `server.js`; Node's ESM resolver does not guess extensions).
      return await nextResolve(`${target}.js`, context);
    }
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return withFallbacks(`${SRC_ROOT}/${specifier.slice(2)}`, context, nextResolve);
  }
  if (specifier === "next/server" || specifier === "next/headers") {
    return withFallbacks(specifier, context, nextResolve);
  }
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return await nextResolve(`${specifier}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
