import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPAIR_MAX_CONTEXT_BYTES,
  REPAIR_MAX_CONTEXT_FILES,
  REPAIR_MAX_FILES,
  REPAIR_MAX_DIAGNOSTIC_CHARS,
} from "../src/lib/sandbox/state";
import { VERIFICATION_MAX_FILE_BYTES } from "../src/lib/sandbox/policy";
import {
  applyRepair,
  buildRepairMessages,
  editableRepairPaths,
  isRepairEditablePath,
  mergedRepairWithinBounds,
  parseRepairResponse,
  repairAllowedFor,
  selectRepairContext,
} from "../src/lib/sandbox/repair";

/**
 * The model's repair output is untrusted. These tests prove that a hostile or
 * malformed response cannot add a file, touch a manifest, escape the snapshot
 * or exceed a bound — not that the model produces a correct repair.
 */

const BASE_FILES = [
  { path: "app/layout.tsx", content: "export default function Layout() { return null; }" },
  { path: "app/page.tsx", content: "export default function Page() { return <main />; }" },
  { path: "package.json", content: '{"scripts":{"build":"next build"}}' },
  { path: "tailwind.config.ts", content: "export default {};" },
];

// ── Editable paths ──────────────────────────────────────────────────────────

test("source files are editable but manifests, lockfiles and credentials are not", () => {
  for (const path of [
    "app/page.tsx",
    "app/layout.tsx",
    "src/components/Hero.tsx",
    "lib/utils.ts",
    "next.config.ts",
    "tailwind.config.js",
    "postcss.config.mjs",
    "styles/globals.css",
  ]) {
    assert.equal(isRepairEditablePath(path), true, path);
  }

  for (const path of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".mavly/runtime.exit",
    ".env",
    ".env.local",
    ".env.production",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "id_rsa",
    "server.key",
    "cert.p12",
    "credentials.json",
    "secrets.json",
    "../outside.ts",
    "/absolute.ts",
    "app/../escape.ts",
    "app\\page.tsx",
    "node_modules/next/index.js",
    ".git/config",
  ]) {
    assert.equal(isRepairEditablePath(path), false, path);
  }
});

test("the editable set preserves the snapshot and drops protected files", () => {
  assert.deepEqual(editableRepairPaths(BASE_FILES), [
    "app/layout.tsx",
    "app/page.tsx",
    "tailwind.config.ts",
  ]);
});

// ── Context selection ───────────────────────────────────────────────────────

test("context starts with the file named by the diagnostics", () => {
  const context = selectRepairContext(BASE_FILES, [
    "Failed to compile: ./app/page.tsx:12:3 Type error",
  ]);
  assert.equal(context.files[0].path, "app/page.tsx");
  assert.equal(context.bytes <= REPAIR_MAX_CONTEXT_BYTES, true);
  assert.equal(context.truncated, false);
});

test("context is capped by file count and bytes, without partial files", () => {
  const many = Array.from({ length: REPAIR_MAX_CONTEXT_FILES + 10 }, (_, index) => ({
    path: `lib/file-${index}.ts`,
    content: "export {};",
  }));
  const capped = selectRepairContext(many, []);
  assert.equal(capped.files.length, REPAIR_MAX_CONTEXT_FILES);
  assert.equal(capped.truncated, true);

  const big = [
    { path: "app/page.tsx", content: "x".repeat(REPAIR_MAX_CONTEXT_BYTES) },
    { path: "lib/extra.ts", content: "export {};" },
  ];
  const byteBound = selectRepairContext(big, []);
  // The large file fits exactly; there is no room left for a second file.
  assert.deepEqual(byteBound.files.map((file) => file.path), ["app/page.tsx"]);
  assert.equal(byteBound.bytes <= REPAIR_MAX_CONTEXT_BYTES, true);
});

test("diagnostics in the prompt are bounded and redacted before they arrive", () => {
  const diagnostics = Array.from(
    { length: 200 },
    (_, index) => `line ${index} ` + "y".repeat(100),
  );
  const context = selectRepairContext(BASE_FILES, diagnostics);
  const messages = buildRepairMessages({
    errorClass: "build_failed",
    summary: "The production build failed.",
    diagnostics,
    context,
  });
  const user = messages.find((message) => message.role === "user");
  assert.notEqual(user, undefined);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content.includes("package.json"), true);
  assert.equal(user!.content.length < 30_000, true);
  assert.equal(user!.content.includes("y".repeat(REPAIR_MAX_DIAGNOSTIC_CHARS + 10)), false);
});

// ── Parsing the model's output ──────────────────────────────────────────────

const ALLOWED = editableRepairPaths(BASE_FILES);

test("a valid replacement inside the allowed files is accepted", () => {
  const raw = JSON.stringify({
    files: [{ path: "app/page.tsx", content: "export default function Page() { return <main>Hi</main>; }" }],
  });
  const parsed = parseRepairResponse(raw, ALLOWED);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].path, "app/page.tsx");
  }
});

test("a fenced JSON answer is unwrapped", () => {
  const raw = [
    "```json",
    JSON.stringify({ files: [{ path: "app/layout.tsx", content: "export default () => null;" }] }),
    "```",
  ].join("\n");
  assert.equal(parseRepairResponse(raw, ALLOWED).ok, true);
});

test("malformed or empty output is rejected with an allowlisted reason", () => {
  const cases: { raw: string; reason: string }[] = [
    { raw: "not json", reason: "invalid_json" },
    { raw: "{}", reason: "no_files" },
    { raw: JSON.stringify({ files: [] }), reason: "no_files" },
    { raw: JSON.stringify({ files: "app/page.tsx" }), reason: "no_files" },
    { raw: JSON.stringify({ files: [null] }), reason: "invalid_entry" },
    { raw: JSON.stringify({ files: [{ path: "app/page.tsx" }] }), reason: "invalid_entry" },
    {
      raw: JSON.stringify({ files: [{ path: "app/page.tsx", content: "" }] }),
      reason: "empty_file",
    },
  ];
  for (const entry of cases) {
    const parsed = parseRepairResponse(entry.raw, ALLOWED);
    assert.equal(parsed.ok, false, entry.raw);
    if (parsed.ok === false) assert.equal(parsed.reason, entry.reason, entry.raw);
  }
});

test("new, protected and duplicate paths are refused", () => {
  const cases: { files: unknown[]; reason: string }[] = [
    {
      files: [{ path: "app/new-page.tsx", content: "export default () => null;" }],
      reason: "path_not_allowed",
    },
    {
      files: [{ path: "package.json", content: '{"scripts":{"build":"true"}}' }],
      reason: "path_not_allowed",
    },
    {
      files: [{ path: ".env.local", content: "SECRET=1" }],
      reason: "path_not_allowed",
    },
    {
      files: [
        { path: "app/page.tsx", content: "export default () => null;" },
        { path: "app/page.tsx", content: "export default () => 1;" },
      ],
      reason: "duplicate_path",
    },
  ];
  for (const entry of cases) {
    const parsed = parseRepairResponse(JSON.stringify({ files: entry.files }), ALLOWED);
    assert.equal(parsed.ok, false, entry.reason);
    if (parsed.ok === false) assert.equal(parsed.reason, entry.reason);
  }
});

test("file count and per-file size are capped before merge", () => {
  const tooMany = Array.from({ length: REPAIR_MAX_FILES + 1 }, (_, index) => ({
    path: index === 0 ? "app/page.tsx" : `app/f-${index}.tsx`,
    content: "x",
  }));
  const countParsed = parseRepairResponse(JSON.stringify({ files: tooMany }), [
    ...ALLOWED,
    ...tooMany.map((file) => file.path),
  ]);
  assert.equal(countParsed.ok, false);
  if (countParsed.ok === false) assert.equal(countParsed.reason, "too_many_files");

  const huge = parseRepairResponse(
    JSON.stringify({
      files: [{ path: "app/page.tsx", content: "x".repeat(VERIFICATION_MAX_FILE_BYTES + 1) }],
    }),
    ALLOWED,
  );
  assert.equal(huge.ok, false);
  if (huge.ok === false) assert.equal(huge.reason, "file_too_large");
});

// ── Applying the change ─────────────────────────────────────────────────────

test("a repair replaces only the named existing files and adds nothing", () => {
  const replacements = [
    { path: "app/page.tsx", content: "export default () => <main>Fixed</main>;" },
    { path: "app/injected.tsx", content: "export default () => null;" },
  ];
  const merged = applyRepair(BASE_FILES, replacements);
  assert.equal(merged.length, BASE_FILES.length);
  assert.equal(merged.map((file) => file.path).join(","), BASE_FILES.map((file) => file.path).join(","));
  assert.equal(merged[1].content, "export default () => <main>Fixed</main>;");
  assert.equal(merged.some((file) => file.path === "app/injected.tsx"), false);
  assert.equal(merged[0].content, BASE_FILES[0].content);
  assert.equal(merged[2].content, BASE_FILES[2].content);
});

test("a merged source must still fit the upload bounds", () => {
  assert.equal(mergedRepairWithinBounds(BASE_FILES), true);
  assert.equal(mergedRepairWithinBounds([]), false);

  const tooMany = Array.from({ length: 81 }, (_, index) => ({
    path: `lib/f-${index}.ts`,
    content: "export {};",
  }));
  assert.equal(mergedRepairWithinBounds(tooMany), false);

  const tooLarge = [{ path: "app/page.tsx", content: "x".repeat(VERIFICATION_MAX_FILE_BYTES + 1) }];
  assert.equal(mergedRepairWithinBounds(tooLarge), false);
});

// ── Eligibility and budget ──────────────────────────────────────────────────

test("only repairable failures inside a bounded budget may run", () => {
  assert.equal(repairAllowedFor("build_failed", 0, 1), true);
  assert.equal(repairAllowedFor("runtime_start_failed", 0, 1), true);
  assert.equal(repairAllowedFor("health_check_failed", 0, 2), true);

  assert.equal(repairAllowedFor("build_failed", 1, 1), false);
  assert.equal(repairAllowedFor("build_failed", 2, 2), false);
  assert.equal(repairAllowedFor("build_failed", 0, 0), false);
  assert.equal(repairAllowedFor("install_failed", 0, 2), false);
  assert.equal(repairAllowedFor("dependency_resolution_failed", 0, 2), false);
  assert.equal(repairAllowedFor("runtime_exited", 0, 2), false);
  assert.equal(repairAllowedFor("timeout", 0, 2), false);
  assert.equal(repairAllowedFor(null, 0, 2), false);
  assert.equal(repairAllowedFor("build_failed", -1, 2), false);
});

test("a requested budget above two is still capped at two", () => {
  assert.equal(repairAllowedFor("build_failed", 1, 50), true);
  assert.equal(repairAllowedFor("build_failed", 2, 50), false);
  assert.equal(repairAllowedFor("build_failed", 1, 1.9), false);
});
