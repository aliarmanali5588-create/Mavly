import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PUBLISHED_VERSION_RETENTION,
  isSharedHostingProject,
  isSharedHostingRuntimeEnabled,
  readHostingConfig,
  sharedDeploymentName,
} from "../src/lib/hosting/config";
import {
  contentTypeForPath,
  isSafePublishedSegment,
  publishedLookupCandidates,
  publishedPathFromSegments,
} from "../src/lib/hosting/published-version";
import {
  preparePublishedFiles,
  publishedContentHash,
} from "../src/lib/hosting/store";

/**
 * ═══ DUAL MODE IS OFF UNLESS EXPLICITLY CONFIGURED ══════════════════════════
 *
 * The legacy per-project Vercel path must remain the production default, and a
 * partial configuration must never move an existing website.
 */

test("the default hosting mode is the legacy Vercel path", () => {
  const config = readHostingConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.mode, "vercel");
  assert.equal(isSharedHostingRuntimeEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(isSharedHostingProject("any-project", {} as NodeJS.ProcessEnv), false);
});

test("shared mode without a cohort enables nothing", () => {
  const env = { MAVLY_HOSTING_MODE: "shared" } as NodeJS.ProcessEnv;
  assert.equal(readHostingConfig(env).mode, "shared");
  assert.equal(isSharedHostingRuntimeEnabled(env), true);
  assert.equal(isSharedHostingProject("any-project", env), false);
});

test("only the explicit cohort uses shared hosting", () => {
  const env = {
    MAVLY_HOSTING_MODE: "shared",
    MAVLY_SHARED_HOSTING_PROJECTS: "meri-ek-car-ki, Other-Project ",
  } as NodeJS.ProcessEnv;
  assert.equal(isSharedHostingProject("meri-ek-car-ki", env), true);
  assert.equal(isSharedHostingProject("other-project", env), true);
  assert.equal(isSharedHostingProject("not-in-the-cohort", env), false);
});

test("`*` is the explicit all-projects opt-in", () => {
  const env = {
    MAVLY_HOSTING_MODE: "shared",
    MAVLY_SHARED_HOSTING_PROJECTS: "*",
  } as NodeJS.ProcessEnv;
  assert.equal(isSharedHostingProject("anything", env), true);
});

test("an unrecognised mode falls back to the legacy path", () => {
  const env = {
    MAVLY_HOSTING_MODE: "yes-please",
    MAVLY_SHARED_HOSTING_PROJECTS: "*",
  } as NodeJS.ProcessEnv;
  assert.equal(readHostingConfig(env).mode, "vercel");
  assert.equal(isSharedHostingProject("anything", env), false);
});

test("a deterministic shared row name never looks like a Vercel project id", () => {
  assert.equal(sharedDeploymentName("meri-ek-car-ki"), "mavly-shared-meri-ek-car-ki");
  assert.equal(PUBLISHED_VERSION_RETENTION >= 1, true);
});

// ── path rules ──────────────────────────────────────────────────────────────

test("the root and index.html both mean the entry document", () => {
  assert.equal(publishedPathFromSegments([], "index.html"), "index.html");
  assert.equal(publishedPathFromSegments(["index.html"], "index.html"), "index.html");
  assert.equal(publishedPathFromSegments([], "landing.html"), "landing.html");
});

test("nested assets keep their exact relative path", () => {
  assert.equal(
    publishedPathFromSegments(["assets", "css", "site.css"], "index.html"),
    "assets/css/site.css",
  );
  assert.equal(
    publishedPathFromSegments(["fonts", "inter.woff2"], "index.html"),
    "fonts/inter.woff2",
  );
});

test("traversal and encoded traversal are refused", () => {
  assert.equal(publishedPathFromSegments([".."], "index.html"), null);
  assert.equal(publishedPathFromSegments([".", "index.html"], "index.html"), null);
  assert.equal(publishedPathFromSegments(["..", "other", "index.html"], "index.html"), null);
  assert.equal(publishedPathFromSegments(["a\\b"], "index.html"), null);
  assert.equal(isSafePublishedSegment("a\u0000b"), false);
  assert.equal(isSafePublishedSegment(""), false);
});

test("a single-label deep link falls back only when SPA policy allows it", () => {
  const spa = publishedLookupCandidates(["pricing"], "index.html", true);
  assert.deepEqual(
    spa.map((candidate) => candidate.path),
    ["pricing", "pricing/index.html", "index.html"],
  );

  const multiPage = publishedLookupCandidates(["pricing"], "index.html", false);
  assert.deepEqual(
    multiPage.map((candidate) => candidate.path),
    ["pricing", "pricing/index.html"],
  );

  // A file-looking path never gets the SPA fallback appended twice.
  const withExtension = publishedLookupCandidates(["app.js"], "index.html", true);
  assert.deepEqual(
    withExtension.map((candidate) => candidate.path),
    ["app.js", "index.html"],
  );
});

test("the root request does not duplicate the entry document", () => {
  const candidates = publishedLookupCandidates([], "index.html", true);
  assert.deepEqual(candidates.map((candidate) => candidate.path), ["index.html"]);
});

test("content types cover the static formats a generated site uses", () => {
  assert.equal(contentTypeForPath("index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeForPath("app.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForPath("styles/site.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeForPath("logo.svg"), "image/svg+xml; charset=utf-8");
  assert.equal(contentTypeForPath("font.woff2"), "font/woff2");
  assert.equal(contentTypeForPath("manifest.webmanifest"), "application/manifest+json; charset=utf-8");
  assert.equal(contentTypeForPath("no-extension"), "application/octet-stream");
});

// ── artifact preparation ────────────────────────────────────────────────────

test("the artifact is hashed, measured and typed before any row is written", () => {
  const prepared = preparePublishedFiles(
    [
      { path: "index.html", content: "<h1>hello</h1>" },
      { path: "assets/site.css", content: "body{}" },
    ],
    contentTypeForPath,
  );

  assert.equal(prepared.ok, true);
  if (prepared.ok === false) return;

  assert.equal(prepared.data.fileCount, 2);
  assert.equal(
    prepared.data.byteCount,
    Buffer.byteLength("<h1>hello</h1>", "utf8") + Buffer.byteLength("body{}", "utf8"),
  );
  assert.equal(prepared.data.contentHash.length, 64);
  assert.deepEqual(
    prepared.data.rows.map((row) => row.path),
    ["index.html", "assets/site.css"],
  );
  assert.equal(prepared.data.rows[0].contentType, "text/html; charset=utf-8");
  assert.equal(prepared.data.rows[1].contentType, "text/css; charset=utf-8");
});

test("the content hash ignores input order", () => {
  const a = publishedContentHash([
    { path: "index.html", sha256: "aa" },
    { path: "app.js", sha256: "bb" },
  ]);
  const b = publishedContentHash([
    { path: "app.js", sha256: "bb" },
    { path: "index.html", sha256: "aa" },
  ]);
  assert.equal(a, b);
  assert.notEqual(a, publishedContentHash([{ path: "index.html", sha256: "aa" }]));
});

test("an empty or unsafe file set is refused before storage", () => {
  const empty = preparePublishedFiles([], contentTypeForPath);
  assert.equal(empty.ok, false);

  const unsafe = preparePublishedFiles(
    [{ path: "../secrets.txt", content: "no" }],
    contentTypeForPath,
  );
  assert.equal(unsafe.ok, false);
  if (unsafe.ok === false) assert.equal(unsafe.code, "VALIDATION");

  const duplicate = preparePublishedFiles(
    [
      { path: "index.html", content: "a" },
      { path: "index.html", content: "b" },
    ],
    contentTypeForPath,
  );
  assert.equal(duplicate.ok, false);
});
