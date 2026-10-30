/**
 * ═══ STATIC VERIFICATION: WHAT MAVLY CAN PROVE WITHOUT EXECUTING ANYTHING ═══
 *
 * A completed generation means the files exist and validated. It does NOT mean
 * the app compiles, starts or renders — those need the opt-in verification
 * sandbox (Vercel microVM, `MAVLY_VERIFICATION_SANDBOX_*`) or a browser runtime,
 * and neither is available to an inline run inside Mavly's own process.
 *
 * This module is the honest middle stage:
 *
 *   A. FILE    — the entry points and manifests exist and are not empty.
 *   B. SYNTAX  — the source is structurally complete (balanced delimiters,
 *                parseable manifests, a complete preview document) and every
 *                relative/aliased import points at a file that exists.
 *
 * It is PURE. It performs no I/O, reads no environment, resolves no package
 * from disk and never executes generated code — the files are data here exactly
 * as they are everywhere else in Mavly.
 *
 * ⚠️ STAGES C (build), D (runtime) AND E (browser) ARE NOT IMPLEMENTED AND ARE
 * NOT SIMULATED. The returned `compiled` / `rendered` / `verified` flags are
 * always `false` and exist so a caller cannot accidentally read "no issues"
 * as "it works". A static pass is NOT a verification `passed`.
 */

import { PREVIEW_ENTRY_PATH, previewDocumentProblem } from "@/lib/preview-document";

export type StaticCheckId =
  | "required_files"
  | "non_empty_files"
  | "package_manifest"
  | "balanced_delimiters"
  | "local_imports"
  | "preview_document";

export type StaticCheckStatus = "pass" | "fail" | "skip";

export interface StaticCheck {
  id: StaticCheckId;
  title: string;
  status: StaticCheckStatus;
  /** Bounded, user-safe detail. Never includes file content. */
  detail: string;
}

/**
 * `not_generated` — nothing has been written yet.
 * `issues` — at least one static check failed; the project needs a repair.
 * `structurally_valid` — A and B passed. Still NOT compiled/rendered/verified.
 */
export type StaticStatus = "not_generated" | "issues" | "structurally_valid";

export interface StaticVerification {
  status: StaticStatus;
  checks: StaticCheck[];
  /**
   * ⚠️ ALWAYS FALSE HERE. They are part of the payload on purpose: the four
   * states the product must never conflate are generated, compiled, rendered and
   * verified, and only `status === "structurally_valid"` is claimed by this
   * module.
   */
  generated: boolean;
  compiled: false;
  rendered: false;
  verified: false;
  summary: string;
}

export interface StaticVerificationInput {
  files: readonly { path: string; content: string }[];
  projectType: "website" | "android";
  /** Create-mode entry points; omitted means "do not require them". */
  requiredPaths?: readonly string[];
}

/** Source extensions whose delimiters and local imports are checked. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
/** Extensions an import specifier may resolve to. */
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".svg",
];

/** Files that are never valid as an empty placeholder. */
const CRITICAL_PATHS = [
  "package.json",
  "app/layout.tsx",
  "app/page.tsx",
  PREVIEW_ENTRY_PATH,
];

const MAX_REPORTED_IMPORTS = 5;

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Strip comments and string/template/regex-free content, then check that
 * brackets balance.
 *
 * ⚠️ THIS IS NOT A PARSER AND DOES NOT CLAIM TO BE. It answers one question —
 * "is this file visibly cut off or structurally broken?" — which is exactly the
 * failure a truncated provider response produces. It must never be described as
 * a syntax check that proves the file compiles.
 */
export function delimitersBalanced(source: string): boolean {
  let index = 0;
  let parens = 0;
  let brackets = 0;
  let braces = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline === -1) break;
      index = newline + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === quote) break;
        // An unterminated single-line string is a broken file.
        if (current === "\n" && quote !== "`") return false;
        index += 1;
      }
      if (index >= source.length) return false;
      index += 1;
      continue;
    }

    if (char === "(") parens += 1;
    else if (char === ")") {
      parens -= 1;
      if (parens < 0) return false;
    } else if (char === "[") brackets += 1;
    else if (char === "]") {
      brackets -= 1;
      if (brackets < 0) return false;
    } else if (char === "{") braces += 1;
    else if (char === "}") {
      braces -= 1;
      if (braces < 0) return false;
    }

    index += 1;
  }

  return parens === 0 && brackets === 0 && braces === 0;
}

/** Every local (relative or `@/`-aliased) module specifier in a source file. */
export function localImportSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@/")) {
        found.push(specifier);
      }
    }
  }
  return found;
}

/**
 * Whether a specifier resolves to a file in the project.
 *
 * ⚠️ A RELATIVE SPECIFIER IS RELATIVE TO THE IMPORTING FILE, not to the project
 * root: `./util` inside `app/page.tsx` means `app/util`, and checking it against
 * `util` would report a perfectly valid import as broken. `importerPath` supplies
 * the directory; an empty one means "project root".
 *
 * `@/` is checked against BOTH conventions (`@/*` → root and → `src/`), because a
 * generated project may use either and a false "broken import" would be worse
 * than reporting nothing.
 */
export function resolvesToProjectFile(
  specifier: string,
  knownPaths: ReadonlySet<string>,
  importerPath = "",
): boolean {
  const isAlias = specifier.startsWith("@/");
  const stripped = isAlias ? specifier.slice(2) : specifier;
  const importerDirectory = importerPath.includes("/")
    ? importerPath.slice(0, importerPath.lastIndexOf("/"))
    : "";
  const bases = isAlias
    ? [stripped, `src/${stripped}`]
    : [normalizeRelative(importerDirectory ? `${importerDirectory}/${stripped}` : stripped)];

  for (const base of bases) {
    for (const extension of RESOLVE_EXTENSIONS) {
      if (knownPaths.has(`${base}${extension}`)) return true;
    }
    for (const extension of RESOLVE_EXTENSIONS.filter((entry) => entry !== "")) {
      if (knownPaths.has(`${base}/index${extension}`)) return true;
    }
  }
  return false;
}

/** Collapse `a/../b` and `./b` into a plain project-relative path. */
function normalizeRelative(specifier: string): string {
  const parts: string[] = [];
  for (const segment of specifier.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function failed(id: StaticCheckId, title: string, detail: string): StaticCheck {
  return { id, title, status: "fail", detail };
}

function passed(id: StaticCheckId, title: string, detail: string): StaticCheck {
  return { id, title, status: "pass", detail };
}

/**
 * Run stages A and B over a project's current files.
 *
 * ⚠️ NOTHING HERE WRITES, PERSISTS OR REPORTS A VERIFICATION RESULT. The caller
 * decides how to present it, and the existing sandbox verification remains the
 * only path that can ever report `passed`.
 */
export function runStaticVerification(input: StaticVerificationInput): StaticVerification {
  const files = input.files.filter(
    (file) => typeof file.path === "string" && typeof file.content === "string",
  );
  const knownPaths = new Set(files.map((file) => file.path));

  if (files.length === 0) {
    return {
      status: "not_generated",
      checks: [
        {
          id: "required_files",
          title: "Project files",
          status: "fail",
          detail: "This project has no generated files yet.",
        },
      ],
      generated: false,
      compiled: false,
      rendered: false,
      verified: false,
      summary: "Nothing has been generated for this project yet.",
    };
  }

  const checks: StaticCheck[] = [];

  // ── A. FILE ────────────────────────────────────────────────────────────────
  const required = input.requiredPaths ?? [];
  const missingRequired = required.filter((path) => !knownPaths.has(path));
  checks.push(
    missingRequired.length === 0
      ? passed(
          "required_files",
          "Required files",
          required.length > 0
            ? `All ${required.length} required entry file(s) are present.`
            : "No entry files were required for this check.",
        )
      : failed(
          "required_files",
          "Required files",
          `Missing ${missingRequired.slice(0, MAX_REPORTED_IMPORTS).join(", ")}${
            missingRequired.length > MAX_REPORTED_IMPORTS ? " and more" : ""
          }.`,
        ),
  );

  const emptyCritical = files
    .filter((file) => CRITICAL_PATHS.includes(file.path) && file.content.trim().length === 0)
    .map((file) => file.path);
  checks.push(
    emptyCritical.length === 0
      ? passed("non_empty_files", "File contents", "No required file is empty.")
      : failed(
          "non_empty_files",
          "File contents",
          `Empty file(s): ${emptyCritical.join(", ")}.`,
        ),
  );

  const packageJson = files.find((file) => file.path === "package.json");
  if (!packageJson) {
    checks.push(
      failed("package_manifest", "package.json", "The project has no package.json."),
    );
  } else {
    let problem: string | null = null;
    try {
      const parsed = JSON.parse(packageJson.content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        problem = "package.json is not a JSON object.";
      } else {
        const record = parsed as Record<string, unknown>;
        if (typeof record.name !== "string" || !record.name.trim()) {
          problem = "package.json has no name.";
        } else if (
          record.dependencies !== undefined &&
          (typeof record.dependencies !== "object" ||
            record.dependencies === null ||
            Array.isArray(record.dependencies))
        ) {
          problem = "package.json dependencies is not an object.";
        }
      }
    } catch {
      problem = "package.json is not valid JSON.";
    }
    checks.push(
      problem
        ? failed("package_manifest", "package.json", problem)
        : passed("package_manifest", "package.json", "package.json parses and is complete."),
    );
  }

  // ── B. SYNTAX (structural) ─────────────────────────────────────────────────
  const brokenSources = files
    .filter((file) => SOURCE_EXTENSIONS.includes(extensionOf(file.path)))
    .filter((file) => file.content.trim().length > 0)
    .filter((file) => !delimitersBalanced(file.content))
    .map((file) => file.path);
  checks.push(
    brokenSources.length === 0
      ? passed(
          "balanced_delimiters",
          "Source structure",
          "Every source file has balanced brackets and terminated strings.",
        )
      : failed(
          "balanced_delimiters",
          "Source structure",
          `Cut off or structurally broken: ${brokenSources
            .slice(0, MAX_REPORTED_IMPORTS)
            .join(", ")}${brokenSources.length > MAX_REPORTED_IMPORTS ? " and more" : ""}.`,
        ),
  );

  const unresolved: string[] = [];
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.includes(extensionOf(file.path))) continue;
    for (const specifier of localImportSpecifiers(file.content)) {
      if (
        !resolvesToProjectFile(specifier, knownPaths, file.path) &&
        !unresolved.includes(`${file.path} → ${specifier}`)
      ) {
        unresolved.push(`${file.path} → ${specifier}`);
      }
    }
  }
  checks.push(
    unresolved.length === 0
      ? passed("local_imports", "Local imports", "Every local import resolves to a project file.")
      : failed(
          "local_imports",
          "Local imports",
          `Unresolved: ${unresolved.slice(0, MAX_REPORTED_IMPORTS).join("; ")}${
            unresolved.length > MAX_REPORTED_IMPORTS ? " and more" : ""
          }.`,
        ),
  );

  const preview = files.find((file) => file.path === PREVIEW_ENTRY_PATH);
  if (!preview) {
    checks.push({
      id: "preview_document",
      title: "Static preview",
      status: "skip",
      detail: "This project has no preview.html.",
    });
  } else {
    const problem = previewDocumentProblem(preview.content);
    checks.push(
      problem
        ? failed("preview_document", "Static preview", `preview.html ${problem}.`)
        : passed(
            "preview_document",
            "Static preview",
            "preview.html is a complete standalone document.",
          ),
    );
  }

  const failures = checks.filter((check) => check.status === "fail");
  const status: StaticStatus = failures.length > 0 ? "issues" : "structurally_valid";

  return {
    status,
    checks,
    generated: true,
    compiled: false,
    rendered: false,
    verified: false,
    summary:
      status === "structurally_valid"
        ? `Static checks passed (${checks.length}). This does NOT mean the app builds, starts or renders: build, runtime and browser verification require the opt-in verification sandbox.`
        : `Static checks found ${failures.length} problem(s): ${failures
            .map((check) => check.title)
            .join(", ")}.`,
  };
}
