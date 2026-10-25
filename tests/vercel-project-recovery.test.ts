import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveVercelProject,
  type VercelProjectClient,
} from "../src/lib/deployments/vercel-project";
import type { VercelProject, VercelResult } from "../src/lib/vercel/provider";

function ok(id: string, name = "mavly-project"): VercelResult<VercelProject> {
  return { ok: true, data: { id, name } };
}

function failed(
  status: number,
  code = "forbidden",
  message = "not accessible",
): VercelResult<VercelProject> {
  return { ok: false, failure: { status, code, message } };
}

function client(
  getProject: (idOrName: string) => VercelResult<VercelProject>,
  createProject: (name: string) => VercelResult<VercelProject> = () => {
    throw new Error("createProject must not be called");
  },
): VercelProjectClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getProject: async (idOrName) => {
      calls.push(`get:${idOrName}`);
      return getProject(idOrName);
    },
    createProject: async (name) => {
      calls.push(`create:${name}`);
      return createProject(name);
    },
  };
}

test("an accessible saved id is reused without creating a project", async () => {
  const fake = client(() => ok("prj_saved"));
  const result = await resolveVercelProject(fake, {
    storedId: "prj_saved",
    name: "mavly-name",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "prj_saved");
  assert.equal(result.data.replacedStoredId, false);
  assert.deepEqual(fake.calls, ["get:prj_saved"]);
});

test("an inaccessible saved id recovers by deterministic name without creating", async () => {
  const fake = client((idOrName) =>
    idOrName === "prj_saved" ? failed(403) : ok("prj_recovered", "mavly-name"),
  );
  const result = await resolveVercelProject(fake, {
    storedId: "prj_saved",
    name: "mavly-name",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "prj_recovered");
  assert.equal(result.data.replacedStoredId, true);
  assert.deepEqual(fake.calls, ["get:prj_saved", "get:mavly-name"]);
});

test("an inaccessible saved id creates the deterministic project when no same-name project exists", async () => {
  const fake = client(
    (idOrName) => (idOrName === "prj_saved" ? failed(403) : failed(404, "not_found")),
    () => ok("prj_created", "mavly-name"),
  );
  const result = await resolveVercelProject(fake, {
    storedId: "prj_saved",
    name: "mavly-name",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "prj_created");
  assert.equal(result.data.replacedStoredId, true);
  assert.deepEqual(fake.calls, [
    "get:prj_saved",
    "get:mavly-name",
    "create:mavly-name",
  ]);
});

test("recovery never creates when the deterministic name is also unauthorized", async () => {
  const fake = client(() => failed(403));
  const result = await resolveVercelProject(fake, {
    storedId: "prj_saved",
    name: "mavly-name",
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.status, 403);
  assert.deepEqual(fake.calls, ["get:prj_saved", "get:mavly-name"]);
});

test("a saved 404 recovers by name", async () => {
  const fake = client((idOrName) =>
    idOrName === "prj_saved" ? failed(404, "not_found") : ok("prj_named"),
  );
  const result = await resolveVercelProject(fake, {
    storedId: "prj_saved",
    name: "mavly-name",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "prj_named");
  assert.equal(result.data.replacedStoredId, true);
});

test("a first publish recovers a project created before its id was saved", async () => {
  const fake = client(
    () => ok("prj_existing", "mavly-name"),
    () => failed(409, "conflict", "already exists"),
  );
  const result = await resolveVercelProject(fake, {
    storedId: null,
    name: "mavly-name",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "prj_existing");
  assert.equal(result.data.replacedStoredId, false);
  assert.deepEqual(fake.calls, ["create:mavly-name", "get:mavly-name"]);
});

test("a first publish surfaces an unauthorized create", async () => {
  const fake = client(
    () => failed(404, "not_found"),
    () => failed(403),
  );
  const result = await resolveVercelProject(fake, {
    storedId: null,
    name: "mavly-name",
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.status, 403);
  assert.deepEqual(fake.calls, ["create:mavly-name"]);
});

test("a transient saved-id read failure keeps the saved target", async () => {
  const fake = client(() => failed(500, "internal_error"));
  const result = await resolveVercelProject(fake, {
    storedId: "prj_saved",
    name: "mavly-name",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "prj_saved");
  assert.equal(result.data.replacedStoredId, false);
  assert.deepEqual(fake.calls, ["get:prj_saved"]);
});
