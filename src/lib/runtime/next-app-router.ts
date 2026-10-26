/**
 * ═══ THE ONE SUPPORTED RUNTIME ══════════════════════════════════════════════
 *
 * The Mavly generator produces a Next.js App Router project. That shape is
 * recognized explicitly; anything else is `unsupported_runtime`. Verification
 * never guesses a framework or falls back to "try `npm run build` and see".
 *
 * The accepted build command is intentionally tiny: an exact `next build`
 * script. A generated manifest is untrusted text, so a script such as
 * `curl … | sh` must not be able to turn this into a command runner.
 */

import {
  DEFAULT_NODE_IMAGE,
  type RuntimeResolution,
  type SourceFile,
} from "./profile";
import {
  nodeImageForEngines,
  parsePackageManifest,
  readNpmLockfile,
  type PackageManifest,
} from "./manifest";

const APP_ROUTER_ENTRIES = {
  layout: /^app\/layout\.(?:tsx|jsx|ts|js)$/,
  page: /^app\/page\.(?:tsx|jsx|ts|js)$/,
} as const;

/** The only accepted build script, after whitespace normalization. */
const ACCEPTED_BUILD_SCRIPT = "next build";

/** Accepted `packageManager` values. npm is the only supported installer. */
const ACCEPTED_PACKAGE_MANAGER = /^npm@\d+(?:\.\d+)*(?:\+.*)?$/;

function unsupported(summary: string, diagnostics: string[] = []): RuntimeResolution {
  return { ok: false, code: "unsupported_runtime", summary, diagnostics };
}

function hasAppRouterEntry(files: readonly SourceFile[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file.path));
}

function declaresNext(manifest: PackageManifest): boolean {
  return (
    typeof manifest.dependencies.next === "string" ||
    typeof manifest.devDependencies.next === "string"
  );
}

/**
 * Resolve a Next.js App Router project to an executable plan, or explain why
 * it cannot be verified. No command is ever derived from the manifest beyond
 * the fixed install/build pair below.
 */
export function planNextAppRouter(files: readonly SourceFile[]): RuntimeResolution {
  const parsed = parsePackageManifest(files);
  if (parsed.ok === false) return parsed;

  const manifest = parsed.manifest;

  if (!hasAppRouterEntry(files, APP_ROUTER_ENTRIES.layout)) {
    return unsupported(
      "This project has no app/layout.tsx, so it is not a Next.js App Router project.",
      ["Verification currently supports the App Router layout the Mavly generator produces."],
    );
  }
  if (!hasAppRouterEntry(files, APP_ROUTER_ENTRIES.page)) {
    return unsupported(
      "This project has no app/page.tsx, so it is not a Next.js App Router project.",
    );
  }
  if (!declaresNext(manifest)) {
    return unsupported(
      "package.json does not declare the `next` dependency, so it is not a Next.js project.",
    );
  }
  if (manifest.workspaces !== undefined) {
    return unsupported(
      "Workspace (monorepo) projects are not supported by verification yet.",
    );
  }
  if (manifest.packageManager && !ACCEPTED_PACKAGE_MANAGER.test(manifest.packageManager)) {
    return unsupported(
      `packageManager "${manifest.packageManager.slice(0, 80)}" is not npm; only npm projects are supported.`,
    );
  }

  const buildScript = (manifest.scripts.build ?? "").replace(/\s+/g, " ").trim();
  if (!buildScript) {
    return unsupported(
      "package.json has no build script, so the project cannot be built deterministically.",
      [`Add a "${ACCEPTED_BUILD_SCRIPT}" build script to verify this project.`],
    );
  }
  if (buildScript !== ACCEPTED_BUILD_SCRIPT) {
    return unsupported(
      "The package.json build script is not the supported `next build` command.",
      [`Found: ${buildScript.slice(0, 200)}`],
    );
  }

  const lockfile = readNpmLockfile(files);
  if (lockfile.ok === false) return lockfile;

  /**
   * Narrow by property presence, not by `image.ok`. This project compiles with
   * `strictNullChecks: false`, where an `ok` discriminator does not reliably
   * narrow the union after an early return (the same workaround `serve.ts` uses
   * for publication probes). `??` keeps "no engines.node" on the default image.
   */
  const image = nodeImageForEngines(manifest.engines) ?? {
    ok: true as const,
    nodeImage: DEFAULT_NODE_IMAGE,
  };
  if (!("nodeImage" in image)) return image;
  const nodeImage = image.nodeImage;

  const install = lockfile.present
    ? { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] }
    : { cmd: "npm", args: ["install", "--no-audit", "--no-fund"] };

  return {
    ok: true,
    plan: {
      profile: "next-app-router",
      nodeImage,
      packageName: manifest.name,
      install,
      // Run the binary directly rather than `npm run build`: npm would also run
      // any generated prebuild/postbuild hooks, which bypasses the script check.
      build: { cmd: "./node_modules/.bin/next", args: ["build"] },
      buildScript: ACCEPTED_BUILD_SCRIPT,
      lockfile: lockfile.present ? "npm" : null,
    },
  };
}
