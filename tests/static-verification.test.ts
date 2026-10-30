import { test } from "node:test";
import assert from "node:assert/strict";

import {
  delimitersBalanced,
  localImportSpecifiers,
  resolvesToProjectFile,
  runStaticVerification,
  type StaticVerification,
} from "../src/lib/verification/static";

/**
 * ═══ STATIC VERIFICATION (STAGES A/B) ═══════════════════════════════════════
 *
 * These tests assert what the module may and may not claim. The `compiled`,
 * `rendered` and `verified` flags are always false here: build, runtime and
 * browser verification need the opt-in sandbox provider and are not simulated.
 */

const PREVIEW = `<!doctype html>
<html lang="en">
  <head><title>Demo</title><style>body{color:#111}</style></head>
  <body><h1>Demo</h1><script>document.title="Demo";</script></body>
</html>`;

const PACKAGE_JSON = JSON.stringify(
  { name: "demo", dependencies: { next: "16.0.0", react: "19.0.0" } },
  null,
  2,
);

function website(): { path: string; content: string }[] {
  return [
    { path: "package.json", content: PACKAGE_JSON },
    {
      path: "app/layout.tsx",
      content: 'import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html>{children}</html>;\n}\n',
    },
    {
      path: "app/page.tsx",
      content: 'import { greet } from "@/lib/greet";\n\nexport default function Page() {\n  return <main>{greet("world")}</main>;\n}\n',
    },
    { path: "app/globals.css", content: "body { margin: 0; }" },
    { path: "lib/greet.ts", content: 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n' },
    { path: "preview.html", content: PREVIEW },
  ];
}

function check(verification: StaticVerification, id: string) {
  return verification.checks.find((entry) => entry.id === id);
}

test("a complete project passes the static stages without claiming more", () => {
  const verification = runStaticVerification({
    files: website(),
    projectType: "website",
    requiredPaths: ["package.json", "app/layout.tsx", "app/page.tsx", "preview.html"],
  });

  assert.equal(verification.status, "structurally_valid");
  assert.equal(verification.generated, true);
  // The four states are never conflated: a static pass is not a verification.
  assert.equal(verification.compiled, false);
  assert.equal(verification.rendered, false);
  assert.equal(verification.verified, false);
  assert.match(verification.summary, /does NOT mean/i);
});

test("a planned file that never materialised is reported", () => {
  const verification = runStaticVerification({
    files: website(),
    projectType: "website",
    requiredPaths: ["app/missing/page.tsx"],
  });
  assert.equal(verification.status, "issues");
  const required = check(verification, "required_files");
  assert.equal(required?.status, "fail");
  assert.match(required?.detail ?? "", /app\/missing\/page\.tsx/);
});

test("an empty critical file is reported", () => {
  const files = website().map((file) =>
    file.path === "app/page.tsx" ? { path: file.path, content: "  \n" } : file,
  );
  const verification = runStaticVerification({ files, projectType: "website" });
  assert.equal(verification.status, "issues");
  assert.equal(check(verification, "non_empty_files")?.status, "fail");
});

test("a truncated source file is detected", () => {
  const files = website().map((file) =>
    file.path === "lib/greet.ts"
      ? { path: file.path, content: "export function greet(name: string) {\n  return `hello" }
      : file,
  );
  const verification = runStaticVerification({ files, projectType: "website" });
  assert.equal(check(verification, "balanced_delimiters")?.status, "fail");
  assert.match(check(verification, "balanced_delimiters")?.detail ?? "", /lib\/greet\.ts/);
});

test("a broken relative import is detected", () => {
  const files = website().map((file) =>
    file.path === "app/page.tsx"
      ? { path: file.path, content: 'import { nope } from "./nope";\n\nexport default function Page() { return null; }\n' }
      : file,
  );
  const verification = runStaticVerification({ files, projectType: "website" });
  assert.equal(check(verification, "local_imports")?.status, "fail");
  assert.match(check(verification, "local_imports")?.detail ?? "", /\.\/nope/);
});

test("an aliased import resolves against both root and src conventions", () => {
  const known = new Set(["src/util.ts", "lib/x.tsx"]);
  assert.equal(resolvesToProjectFile("@/util", known), true);
  assert.equal(resolvesToProjectFile("@/lib/x", known), true);
  assert.equal(resolvesToProjectFile("@/util/missing", known), false);
});

/**
 * ⚠️ A RELATIVE SPECIFIER IS RELATIVE TO ITS IMPORTER. Checking `./lib/util`
 * from `app/page.tsx` against the project root would report a valid import as
 * broken, and a false finding is worse than no finding.
 */
test("a relative import resolves against the importing file's directory", () => {
  const known = new Set(["app/lib/util.ts"]);
  assert.equal(resolvesToProjectFile("./lib/util", known, "app/page.tsx"), true);
  assert.equal(resolvesToProjectFile("./lib/util", known, ""), false);

  const nested = new Set(["app/components/card.tsx"]);
  assert.equal(resolvesToProjectFile("./card", nested, "app/components/Other.tsx"), true);
  assert.equal(resolvesToProjectFile("../components/card", nested, "app/pages/Index.tsx"), true);
});

test("a directory import resolves to its index file", () => {
  const known = new Set(["lib/util/index.ts"]);
  assert.equal(resolvesToProjectFile("./lib/util", known), true);
});

test("a complete preview document passes and a cut-off one fails", () => {
  const good = runStaticVerification({ files: website(), projectType: "website" });
  assert.equal(check(good, "preview_document")?.status, "pass");

  const files = website().map((file) =>
    file.path === "preview.html" ? { path: file.path, content: "<!doctype html><html><body>Demo" } : file,
  );
  const bad = runStaticVerification({ files, projectType: "website" });
  assert.equal(check(bad, "preview_document")?.status, "fail");
  assert.equal(bad.status, "issues");
});

test("an unparseable package.json is reported", () => {
  const files = website().map((file) =>
    file.path === "package.json" ? { path: file.path, content: "{ not json" } : file,
  );
  const verification = runStaticVerification({ files, projectType: "website" });
  assert.equal(check(verification, "package_manifest")?.status, "fail");
});

test("an android project is checked without requiring web entry points", () => {
  const verification = runStaticVerification({
    files: [
      { path: "package.json", content: PACKAGE_JSON },
      { path: "app/src/main/java/MainActivity.kt", content: "class MainActivity\n" },
    ],
    projectType: "android",
  });
  assert.equal(verification.status, "structurally_valid");
  assert.equal(check(verification, "preview_document")?.status, "skip");
});

test("a project with no files is not reported as generated", () => {
  const verification = runStaticVerification({ files: [], projectType: "website" });
  assert.equal(verification.status, "not_generated");
  assert.equal(verification.generated, false);
});

test("delimiters inside comments and strings do not count", () => {
  assert.equal(delimitersBalanced('const a = "{ not a brace }"; // }\nconst b = [1, 2];\n'), true);
  assert.equal(delimitersBalanced("/* } */ const a = { b: 1 };\n"), true);
  assert.equal(delimitersBalanced("const a = { b: 1;\n"), false);
  assert.equal(delimitersBalanced('const s = "unterminated\n'), false);
});

test("only local specifiers are collected", () => {
  const found = localImportSpecifiers(
    'import a from "next/link";\nimport b from "./b";\nconst c = require("../c");\nimport("@/d");\n',
  );
  assert.deepEqual([...found].sort(), ["../c", "./b", "@/d"].sort());
  assert.equal(found.includes("next/link"), false);
});
