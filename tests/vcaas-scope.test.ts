import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRequestIdentity,
  classifyVcaasRequest,
  filterAccountUsage,
  filterAtLimitAnswer,
  filterProjectList,
} from "../src/lib/vcaas-scope";

/**
 * ═══ THE CATCH-ALL'S ALLOWLIST ═════════════════════════════════════════════
 *
 * This is the security boundary that decides whether an arbitrary
 * `/api/vcaas/<path>` is forwarded with the account-wide Totalum key. The cases
 * below are the contract:
 *
 *  · project paths resolve to a project id and are ownership-checked;
 *  · the ONE method-specific literal that overlaps a project id
 *    (`POST /projects/launch` vs `GET /projects/launch`) is not confused;
 *  · account endpoints are explicit, not "everything that isn't /projects";
 *  · an unknown root is refused — this is what keeps a future endpoint from
 *    silently re-opening F-1;
 *  · a body/query project id can never smuggle a different project past the
 *    path check.
 */

const allow = (scope: ReturnType<typeof classifyVcaasRequest>) => {
  assert.notEqual(scope.kind, "deny", `expected allow, got ${JSON.stringify(scope)}`);
  return scope;
};

// ── project-scoped ─────────────────────────────────────────────────────────

test("project subpaths resolve to the path's project id", () => {
  for (const path of [
    ["projects", "my-app"],
    ["projects", "my-app", "agent", "status"],
    ["projects", "my-app", "files", "tree"],
    ["projects", "my-app", "deployments", "deploy"],
    ["projects", "my-app", "deployments", "unpublish"],
  ]) {
    const scope = allow(classifyVcaasRequest("POST", path));
    assert.equal(scope.kind, "project");
    if (scope.kind === "project") assert.equal(scope.projectId, "my-app");
  }
});

test("the dedicated project roots are classified the same way", () => {
  for (const root of ["upload", "source-code", "env"]) {
    const scope = allow(classifyVcaasRequest("GET", [root, "my-app"]));
    assert.equal(scope.kind, "project");
    if (scope.kind === "project") assert.equal(scope.projectId, "my-app");

    assert.equal(classifyVcaasRequest("GET", [root]).kind, "deny");
    assert.equal(classifyVcaasRequest("GET", [root, "Bad_Slug"]).kind, "deny");
  }
});

test("a malformed project id is refused before any lookup", () => {
  for (const bad of ["UPPER", "Bad_Slug", "a--b", "-a", "a-", "a".repeat(64), "../etc"]) {
    const scope = classifyVcaasRequest("GET", ["projects", bad]);
    assert.equal(scope.kind, "deny", bad);
    if (scope.kind === "deny") assert.equal(scope.status, 400);
  }
});

// ── the launch/list/create overlap ─────────────────────────────────────────

test("POST /projects/launch creates; GET /projects/launch is a project READ", () => {
  // ⚠️ The literal is method-specific. Treating every `launch` segment as an
  // action would let `GET /projects/launch` skip the ownership check.
  const launch = allow(classifyVcaasRequest("POST", ["projects", "launch"]));
  assert.equal(launch.kind, "create");
  if (launch.kind === "create") assert.equal(launch.mode, "launch");

  const read = allow(classifyVcaasRequest("GET", ["projects", "launch"]));
  assert.equal(read.kind, "project");
  if (read.kind === "project") assert.equal(read.projectId, "launch");
});

test("list and create are the only things `/projects` itself allows", () => {
  const list = allow(classifyVcaasRequest("GET", ["projects"]));
  assert.equal(list.kind, "account");
  if (list.kind === "account") assert.equal(list.resource, "project-list");

  const create = allow(classifyVcaasRequest("POST", ["projects"]));
  assert.equal(create.kind, "create");
  if (create.kind === "create") assert.equal(create.mode, "create");

  assert.equal(classifyVcaasRequest("DELETE", ["projects"]).kind, "deny");
});

test("credit-limits/at-limit is account-level; a project's own limit is not", () => {
  const account = allow(classifyVcaasRequest("GET", ["projects", "credit-limits", "at-limit"]));
  assert.equal(account.kind, "account");
  if (account.kind === "account") assert.equal(account.resource, "credit-limits-at-limit");
  assert.equal(classifyVcaasRequest("POST", ["projects", "credit-limits", "at-limit"]).kind, "deny");

  const project = allow(classifyVcaasRequest("GET", ["projects", "my-app", "credit-limits"]));
  assert.equal(project.kind, "project");
});

// ── the account allowlist ──────────────────────────────────────────────────

test("only the vetted account endpoints are allowed", () => {
  const cases: Array<[string, string[], string]> = [
    ["GET", ["credit-costs"], "credit-costs"],
    ["GET", ["usage"], "usage"],
    ["GET", ["webhooks"], "webhooks"],
    ["POST", ["webhooks"], "webhooks"],
    ["DELETE", ["webhooks", "wh_1"], "webhooks"],
    ["GET", ["project-groups"], "project-groups"],
    ["PATCH", ["project-groups", "grp_1"], "project-groups"],
    ["GET", ["domains"], "domains"],
    ["POST", ["domains", "d_1", "attach"], "domains"],
    ["POST", ["figma", "validate"], "figma-validate"],
  ];

  for (const [method, path, resource] of cases) {
    const scope = allow(classifyVcaasRequest(method, path));
    assert.equal(scope.kind, "account", `${method} ${path.join("/")}`);
    if (scope.kind === "account") assert.equal(scope.resource, resource);
  }
});

test("an unknown root is refused, not forwarded", () => {
  // ⚠️ This is the anti-F-1 rule. A catalogued endpoint nobody classified must
  // not reach the account-wide key by default.
  for (const path of [
    ["account"],
    ["accounts"],
    ["credits"],
    ["projects2", "my-app"],
    ["", "my-app"],
  ]) {
    const scope = classifyVcaasRequest("GET", path);
    assert.equal(scope.kind, "deny", path.join("/"));
    if (scope.kind === "deny") assert.equal(scope.status, 404);
  }
});

test("git-diff is not reachable through the catch-all", () => {
  assert.equal(classifyVcaasRequest("GET", ["git-diff"]).kind, "deny");
});

// ── body / query identity ──────────────────────────────────────────────────

const q = (value?: string) => new URLSearchParams(value === undefined ? {} : { projectId: value });

test("a matching body/query project id is allowed", () => {
  const scope = allow(classifyVcaasRequest("POST", ["projects", "my-app", "agent", "start"]));
  assert.deepEqual(checkRequestIdentity(scope, ["projects", "my-app"], q("my-app"), { projectId: "my-app" }), {
    kind: "allow",
  });
});

test("a conflicting body/query project id is refused", () => {
  const scope = allow(classifyVcaasRequest("POST", ["projects", "my-app", "agent", "start"]));

  for (const check of [
    checkRequestIdentity(scope, ["projects", "my-app"], q(), { projectId: "other-app" }),
    checkRequestIdentity(scope, ["projects", "my-app"], q("other-app"), {}),
  ]) {
    assert.equal(check.kind, "deny");
    if (check.kind === "deny") {
      assert.equal(check.status, 400);
      assert.equal(check.code, "CONFLICTING_PROJECT");
    }
  }
});

test("duplicate query project ids are refused (get() vs upstream's last-wins)", () => {
  const scope = allow(classifyVcaasRequest("GET", ["projects", "my-app"]));
  const check = checkRequestIdentity(
    scope,
    ["projects", "my-app"],
    new URLSearchParams("projectId=my-app&projectId=theirs"),
    {},
  );
  assert.equal(check.kind, "deny");
  if (check.kind === "deny") assert.equal(check.code, "CONFLICTING_PROJECT");
});

test("a malformed carried project id is refused even when absent from the path", () => {
  const scope = allow(classifyVcaasRequest("POST", ["projects"]));
  for (const body of [{ projectId: "" }, { projectId: 42 }, { projectId: null }]) {
    const check = checkRequestIdentity(scope, ["projects"], q(), body);
    assert.equal(check.kind, "deny", JSON.stringify(body));
    if (check.kind === "deny") assert.equal(check.status, 400);
  }
});

test("a create request may name a slug, but not a query project", () => {
  const scope = allow(classifyVcaasRequest("POST", ["projects", "launch"]));
  assert.deepEqual(checkRequestIdentity(scope, ["projects", "launch"], q(), { projectId: "billing-pos" }), {
    kind: "allow",
  });
  assert.equal(checkRequestIdentity(scope, ["projects", "launch"], q("billing-pos"), {}).kind, "deny");
});

test("domain purchase/attach authorize the body's project; other account paths refuse one", () => {
  const purchase = allow(classifyVcaasRequest("POST", ["domains", "purchase"]));
  assert.deepEqual(checkRequestIdentity(purchase, ["domains", "purchase"], q(), { projectId: "my-app" }), {
    kind: "authorize",
    projectId: "my-app",
  });

  const attach = allow(classifyVcaasRequest("POST", ["domains", "d_1", "attach"]));
  assert.deepEqual(checkRequestIdentity(attach, ["domains", "d_1", "attach"], q(), { projectId: "my-app" }), {
    kind: "authorize",
    projectId: "my-app",
  });

  // Missing project id is left to upstream (its own validation), never guessed.
  assert.deepEqual(checkRequestIdentity(attach, ["domains", "d_1", "attach"], q(), {}), { kind: "allow" });

  const list = allow(classifyVcaasRequest("GET", ["domains"]));
  const ambiguous = checkRequestIdentity(list, ["domains"], q(), { projectId: "my-app" });
  assert.equal(ambiguous.kind, "deny");
  if (ambiguous.kind === "deny") assert.equal(ambiguous.code, "AMBIGUOUS_PROJECT");
});

// ── list filtering ─────────────────────────────────────────────────────────

const owned = new Set(["mine", "also-mine"]);

test("the account-wide project list is narrowed to owned ids", () => {
  const rows = [
    { projectId: "mine", name: "Mine" },
    { projectId: "theirs", name: "Theirs" },
    { projectId: "also-mine", name: "Also" },
    { name: "no id" },
    null,
  ];
  assert.deepEqual(filterProjectList(rows, owned), [
    { projectId: "mine", name: "Mine" },
    { projectId: "also-mine", name: "Also" },
  ]);
});

test("the at-limit answer keeps only owned projects and keeps the rest", () => {
  const answer = {
    isAtLimit: true,
    limit: 3,
    projects: [{ projectId: "mine" }, { projectId: "theirs" }],
  };
  assert.deepEqual(filterAtLimitAnswer(answer, owned), {
    isAtLimit: true,
    limit: 3,
    projects: [{ projectId: "mine" }],
  });
});

test("the account usage breakdown is narrowed; totals are left alone", () => {
  const answer = {
    totalCredits: 100,
    byProject: [{ projectId: "mine", credits: 10 }, { projectId: "theirs", credits: 90 }],
  };
  assert.deepEqual(filterAccountUsage(answer, owned), {
    totalCredits: 100,
    byProject: [{ projectId: "mine", credits: 10 }],
  });
});

test("filters leave unexpected shapes untouched rather than mangling them", () => {
  assert.equal(filterProjectList({ not: "a list" }, owned).constructor, Object);
  assert.deepEqual(filterAtLimitAnswer({ projects: "nope" }, owned), { projects: "nope" });
  assert.deepEqual(filterAccountUsage(null, owned), null);
});
