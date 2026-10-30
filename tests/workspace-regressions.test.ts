import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { GET as sourceCodeGet } from "../src/app/api/vcaas/source-code/[projectId]/route";

/**
 * ═══ THE FOUR PRODUCTION FINDINGS, AS REGRESSION GUARDS ════════════════════
 *
 * Each test pins one behaviour that was wrong and is now fixed. They are
 * deliberately narrow: a source assertion for the rules that live in a route or a
 * component, plus one behavioural call for the rule that can be exercised without
 * a database (the authorization order).
 *
 * `PROJECT_EMPTY` — an owned project with no files is not "not found".
 * `isPublishingUnavailable` — a permanent "no provider" is not retried, and a
 *   transient 503 (a gateway failure) still is.
 * Hydration — browser state is adopted in an effect, never in a render initializer.
 * Preview 404 — `/api/preview/{slug}` is a project slug, not a feature endpoint;
 *   no ElevenLabs route exists or may be invented, and the route never fakes one.
 */

const read = (path: string) => readFileSync(path, "utf8");
const sourceCodeRoute = "src/app/api/vcaas/source-code/[projectId]/route.ts";

test("an empty project answers PROJECT_EMPTY (409), never PROJECT_NOT_FOUND", () => {
  const source = read(sourceCodeRoute);
  assert.ok(source.includes('"PROJECT_EMPTY"'), "the empty state needs its own code");
  assert.ok(source.includes("status: 409"), "an empty project is a state conflict, not a 404");
  assert.equal(
    source.includes('code: "PROJECT_NOT_FOUND"'),
    false,
    "this route cannot know whether a project exists (ownership answers a non-enumerating 403)",
  );
});

test("the source route still authorizes before it reads project files", () => {
  const source = read(sourceCodeRoute);
  const authAt = source.indexOf("authorizeProjectRequest");
  const readAt = source.indexOf("listFiles(");
  assert.ok(authAt > 0, "the route must call the ownership guard");
  assert.ok(readAt > authAt, "authorization must come before any file read");
  assert.ok(
    source.indexOf("searchParams.get(\"intent\")") > authAt,
    "the intent is validated after the session, never before it",
  );
});

test("an anonymous caller is refused with 401 even for a malformed intent", async () => {
  const request = new NextRequest(
    "http://localhost:3000/api/vcaas/source-code/my-app?intent=bogus",
  );
  const response = await sourceCodeGet(request, {
    params: Promise.resolve({ projectId: "my-app" }),
  });
  assert.equal(response.status, 401);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "UNAUTHENTICATED");
});

test("a permanently unconfigured deployment is not polled or retried", () => {
  const page = read("src/app/project/[projectId]/page.tsx");
  assert.ok(
    page.includes("function isPublishingUnavailable("),
    "the permanent refusal needs one shared predicate",
  );
  assert.ok(
    page.includes('return response.code === "BACKEND_NOT_CONFIGURED";'),
    "only the exact no-provider refusal is permanent",
  );
  assert.equal(
    page.includes("response.status === 503"),
    false,
    "a bare 503 (a gateway or origin failure) is transient: it keeps its bounded " +
      "retry and must never be reported as 'no deployment provider is configured'",
  );
  assert.ok(
    (page.match(/isPublishingUnavailable\(/g) || []).length >= 3,
    "both the watcher and the mount read must use it",
  );
  assert.ok(
    page.includes("Publishing is not available on this deployment."),
    "the user is told the truth instead of 'refresh in a moment'",
  );
});

test("browser-only state is adopted after hydration, never in a render initializer", () => {
  const runaway = read("src/components/workspace/v2/RunawayNotice.tsx");
  assert.equal(
    runaway.includes("typeof window !== \"undefined\" && new URLSearchParams"),
    false,
    "reading window.location.search inside useState is a #418 mismatch",
  );
  assert.ok(
    runaway.includes("React.useEffect(") && runaway.includes("setConfirming(true)"),
    "the deep link is adopted in an effect instead",
  );

  const offline = read("src/components/pwa/OfflineBanner.tsx");
  assert.equal(
    offline.includes("typeof navigator !== \"undefined\" && !navigator.onLine"),
    false,
    "navigator.onLine cannot be read during the server render",
  );
  assert.ok(
    offline.includes("setOffline(!navigator.onLine)"),
    "connectivity is read in the effect",
  );
});

/*
 * ══ PHASE 4 — `/api/preview/generate-elevenlabs-clone` ═════════════════════
 *
 * There is no ElevenLabs (or any other per-feature) endpoint in this codebase and
 * there never was one: the source, the build output and the full git history
 * contain no such string, so there is no obsolete caller to delete. The path is
 * the generic preview route with a PROJECT SLUG in its `[projectId]` slot —
 * `generate-elevenlabs-clone` is `slugify("Generate ElevenLabs clone")` — and the
 * 404 is that route truthfully reporting an owned project with nothing previewable
 * to serve.
 *
 * These tests pin that finding: nothing may reintroduce a fake feature endpoint
 * or a caller for one, and the route that actually answers must keep authorizing
 * before it reads and must never fabricate a preview.
 */

function sourceFilesUnder(root: string): string[] {
  return (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => join(root, entry));
}

test("no ElevenLabs endpoint exists and no source file calls one", () => {
  const offenders = sourceFilesUnder("src").filter((file) =>
    /elevenlabs/i.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "the observed /api/preview/generate-elevenlabs-clone is a project slug in the " +
      "generic preview route, not a feature endpoint — adding one would fabricate " +
      "a generation that never happened",
  );
});

test("the preview route authorizes before it reads files and never fabricates a preview", () => {
  const source = read("src/app/api/preview/[projectId]/[[...path]]/route.ts");
  const authAt = source.indexOf("await authorizeProjectRequest(");
  const projectAt = source.indexOf("await getProject(");
  const filesAt = source.indexOf("await listFiles(");
  assert.ok(authAt > 0, "the preview must be gated by the ownership guard");
  assert.ok(projectAt > authAt, "the project row is read only after authorization");
  assert.ok(filesAt > authAt, "project files are read only after authorization");
  // A project with nothing previewable is an honest 404, never a 200 with an
  // empty or invented document.
  assert.ok(
    source.includes("if (!resolved.site) return notFound(resolved.reason);"),
    "an unservable preview must be refused, not faked",
  );
  assert.ok(
    source.includes('return notFound("This file is not part of the preview.");'),
    "an unknown path under the preview is a 404, not the entry document",
  );
});
