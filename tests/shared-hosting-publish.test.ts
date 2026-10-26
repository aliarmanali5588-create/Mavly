import { test } from "node:test";
import assert from "node:assert/strict";

import {
  publishSharedVersion,
  wireDeploymentStatus,
} from "../src/lib/deployments/service";
import type { SharedPublishDependencies } from "../src/lib/deployments/service";
import type {
  DeploymentRow,
  DeploymentStatus,
  MavlyDomainStatus,
} from "../src/lib/deployments/store";
import type { HostingStoreResult } from "../src/lib/hosting/store";
import type { SharedPublicationProbe } from "../src/lib/hosting/serve";
import { sharedDeploymentName } from "../src/lib/hosting/config";
import {
  SHARED_HOSTING_INSTALL_MESSAGE,
  migrationRequirementMessage,
  requiredMigrationFor,
} from "../src/lib/hosting/migration-requirement";
import type { StaticSite } from "../src/lib/static-site";

/**
 * ═══ A PUBLISH ATTEMPT MUST NEVER TAKE THE LIVE SITE DOWN ═══════════════════
 *
 * Shared hosting separates two things that migration 14 conflated:
 *
 *   LIVE STATE      the active version + `active_version_id`;
 *   ATTEMPT STATE   `project_deployments.status` for the latest publish.
 *
 * These tests drive the real orchestration with an in-memory fake store. They
 * pin the ordering (store → activate → probe), the failure semantics (a failed
 * attempt changes only attempt state) and the migration preflight (nothing is
 * written before migration 15 is proven installed).
 *
 * ⚠️ THIS IS NOT A DATABASE TEST. No Supabase project is contacted; the SQL
 * itself is pinned separately in `shared-hosting-attempt-state-migration.test.ts`.
 */

const PROJECT = "proj-alpha";
const HOST = `${PROJECT}.mavly.xyz`;
const NOW = "2026-01-01T00:00:00.000Z";
/** The activation transaction's `now()`; distinct from the previous publish. */
const ACTIVATED_AT = "2026-01-02T00:00:00.000Z";
const PREVIOUS_PUBLISHED_AT = "2025-12-01T00:00:00.000Z";

const INPUT = {
  projectId: PROJECT,
  hostname: HOST,
  site: { entryPath: "index.html", root: "", generated: true } satisfies StaticSite,
  publishFiles: [{ path: "index.html", content: "<h1>hello</h1>" }],
};

interface FakeState {
  row: DeploymentRow;
  /** version id → status, mirroring project_published_versions.status */
  versions: Map<string, "draft" | "active" | "superseded" | "failed">;
}

function makeRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    project_id: PROJECT,
    provider: "shared",
    vercel_project_id: null,
    vercel_project_name: sharedDeploymentName(PROJECT),
    vercel_deployment_id: null,
    status: "unpublished",
    url: null,
    error_code: null,
    error_message: null,
    mavly_hostname: null,
    mavly_domain_status: null,
    mavly_domain_error: null,
    mavly_domain_checked_at: null,
    active_version_id: null,
    created_at: NOW,
    updated_at: NOW,
    last_published_at: null,
    last_unpublished_at: null,
    ...overrides,
  };
}

interface HarnessOptions {
  initial?: Partial<DeploymentRow>;
  versions?: Array<[string, "draft" | "active" | "superseded" | "failed"]>;
  schema?: HostingStoreResult<number>;
  create?: HostingStoreResult<{ id: string; contentHash: string; fileCount: number; byteCount: number }>;
  activate?: HostingStoreResult<void>;
  probe?: SharedPublicationProbe;
  record?: HostingStoreResult<DeploymentRow>;
}

function harness(options: HarnessOptions = {}) {
  const state: FakeState = {
    row: makeRow(options.initial),
    versions: new Map(options.versions ?? []),
  };

  const calls: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  let beginOptions: { preserveLastPublishedAt?: boolean } | null = null;

  const deps: SharedPublishDependencies = {
    schema: async () => {
      calls.push("schema");
      return options.schema ?? { ok: true, data: 15 };
    },
    begin: async (_projectId, _name, _provider, begin) => {
      calls.push("begin");
      beginOptions = begin;
      /**
       * Claiming an attempt writes `queued` and never touches
       * `active_version_id` or the hostname. That is the property under test.
       */
      state.row = { ...state.row, status: "queued", updated_at: NOW };
      return { ok: true, data: { ...state.row } };
    },
    createVersion: async () => {
      calls.push("createVersion");
      if (options.create) return options.create;
      state.versions.set("v2", "draft");
      return {
        ok: true,
        data: { id: "v2", contentHash: "hash-2", fileCount: 1, byteCount: 17 },
      };
    },
    activate: async (_projectId, versionId) => {
      calls.push("activate");
      if (options.activate) return options.activate;
      for (const [id, status] of state.versions) {
        if (status === "active" && id !== versionId) state.versions.set(id, "superseded");
      }
      state.versions.set(versionId, "active");
      state.row = {
        ...state.row,
        status: "ready",
        active_version_id: versionId,
        mavly_hostname: HOST,
        /** Mirrors `last_published_at = now()` inside the activation transaction. */
        last_published_at: ACTIVATED_AT,
      };
      return { ok: true, data: undefined };
    },
    probe: async (_hostname, versionId) => {
      calls.push("probe");
      if (options.probe) return options.probe;
      const version = {
        projectId: PROJECT,
        versionId,
        publishedAt: NOW,
        contentHash: "hash-2",
        entryPath: "index.html",
        spaFallback: true,
      };
      return { ok: true, version };
    },
    recordRow: async (_projectId, patch) => {
      calls.push("recordRow");
      patches.push({ ...patch });
      if (options.record) return options.record;
      state.row = { ...state.row, ...patch } as DeploymentRow;
      return { ok: true, data: { ...state.row } };
    },
    markFailed: async (versionId) => {
      calls.push("markFailed");
      state.versions.set(versionId, "failed");
    },
    prune: async () => {
      calls.push("prune");
      return 0;
    },
    log: () => {},
  };

  return {
    deps,
    state,
    calls,
    patches,
    beginOptions: () => beginOptions,
  };
}

function liveRow(status: DeploymentStatus, domain: MavlyDomainStatus | null): Partial<DeploymentRow> {
  return {
    status,
    active_version_id: "v1",
    mavly_hostname: HOST,
    mavly_domain_status: domain,
    last_published_at: PREVIOUS_PUBLISHED_AT,
  };
}

function indexOf(calls: string[], name: string): number {
  return calls.indexOf(name);
}

test("a republish keeps the previous version live until activation commits", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
  });

  const create = h.deps.createVersion;
  let liveWhenStored: string | null = null;
  h.deps.createVersion = async (input) => {
    liveWhenStored = h.state.row.active_version_id ?? null;
    return create(input);
  };

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, true);

  // Writing the new artifact did not change the serving pointer.
  assert.equal(liveWhenStored, "v1");
  assert.equal(h.calls.filter((call) => call === "recordRow").length, 1);
  assert.ok(indexOf(h.calls, "activate") < indexOf(h.calls, "recordRow"));
  assert.ok(indexOf(h.calls, "recordRow") < indexOf(h.calls, "prune"));

  // Activation is the only transition that changes the live version.
  assert.equal(h.state.row.active_version_id, "v2");
  assert.equal(h.state.versions.get("v1"), "superseded");
  assert.equal(h.state.versions.get("v2"), "active");
  assert.equal(h.state.row.status, "ready");
});

test("a successful publish stamps last_published_at; the attempt claim does not", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
  });

  await publishSharedVersion(INPUT, h.deps);

  assert.deepEqual(h.beginOptions(), { preserveLastPublishedAt: true });
  // Only the activation transaction moves the timestamp forward.
  assert.equal(h.state.row.last_published_at, ACTIVATED_AT);
});

test("a failed republish preserves the last successful publication", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
    activate: {
      ok: false,
      error: "raw database failure that must not reach the browser",
      code: "XX000",
    },
  });

  const result = await publishSharedVersion(INPUT, h.deps);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 500);
  assert.equal(result.code, "UNKNOWN");
  assert.match(result.error, /previous published version was left unchanged/i);
  assert.doesNotMatch(result.error, /raw database failure/);

  // Live state is untouched; only attempt state changed.
  assert.equal(h.state.row.active_version_id, "v1");
  assert.equal(h.state.versions.get("v1"), "active");
  assert.equal(h.state.versions.get("v2"), "failed");
  assert.equal(h.state.row.status, "error");
  assert.equal(h.state.row.error_code, "shared_publish_failed");
  assert.equal(h.state.row.last_published_at, PREVIOUS_PUBLISHED_AT);
  assert.match(h.state.row.error_message ?? "", /left unchanged/i);
  assert.doesNotMatch(h.state.row.error_message ?? "", /raw database failure/);

  // Never report the attempt as a success.
  const wire = wireDeploymentStatus(h.state.row);
  assert.equal(wire.status, "error");
  assert.equal(wire.liveUrl, undefined);
});

test("a first failed publish reports error and never pretends the site is live", async () => {
  const h = harness({
    activate: { ok: false, error: "activation failed", code: "XX000" },
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 500);

  assert.equal(h.state.row.active_version_id, null);
  assert.equal(h.state.row.mavly_hostname, null);
  assert.equal(h.state.row.status, "error");

  const wire = wireDeploymentStatus(h.state.row);
  assert.equal(wire.status, "error");
  assert.equal(wire.status === "success", false);
  assert.equal(wire.canUnpublish, false);
  assert.equal(wire.liveUrl, undefined);
});

test("a failed artifact write never activates or probes", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
    create: { ok: false, error: "storage is full", code: "XX000" },
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, false);

  assert.equal(indexOf(h.calls, "activate"), -1);
  assert.equal(indexOf(h.calls, "probe"), -1);
  assert.equal(h.state.row.active_version_id, "v1");
  assert.equal(h.state.versions.get("v1"), "active");
  assert.equal(h.state.row.status, "error");
});

test("activation is attempted only after the version is stored, and probed only after activation", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
  });

  await publishSharedVersion(INPUT, h.deps);

  const storeAt = indexOf(h.calls, "createVersion");
  const activateAt = indexOf(h.calls, "activate");
  const probeAt = indexOf(h.calls, "probe");
  assert.ok(storeAt >= 0 && activateAt > storeAt && probeAt > activateAt);
});

test("with activation failed the runtime is never probed and nothing is marked verified", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
    activate: { ok: false, error: "activation failed", code: "XX000" },
  });

  await publishSharedVersion(INPUT, h.deps);

  assert.equal(indexOf(h.calls, "probe"), -1);
  assert.ok(h.patches.every((patch) => patch.mavly_domain_status !== "verified"));
});

test("a probe that cannot resolve the exact version stays pending, never verified", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
    probe: { ok: false, reason: "not_resolved" },
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, true);

  assert.equal(h.state.row.active_version_id, "v2");
  assert.equal(h.state.versions.get("v2"), "active");
  assert.equal(h.state.row.mavly_domain_status, "pending");
  assert.ok(h.state.row.mavly_domain_error);
  assert.ok(h.patches.every((patch) => patch.mavly_domain_status !== "verified"));

  const wire = wireDeploymentStatus(h.state.row);
  assert.equal(wire.status, "deploying");
  assert.equal(wire.liveUrl, undefined);
});

test("only a successful exact-version probe becomes verified", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, true);

  assert.equal(h.state.row.mavly_domain_status, "verified");
  const wire = wireDeploymentStatus(h.state.row);
  assert.equal(wire.status, "success");
  assert.equal(wire.liveUrl, `https://${HOST}`);
});

test("a missing migration fails closed before any write", async () => {
  const h = harness({
    schema: {
      ok: false,
      error: SHARED_HOSTING_INSTALL_MESSAGE,
      code: "MIGRATION_REQUIRED",
    },
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.status, 503);
  assert.equal(result.code, "BACKEND_NOT_CONFIGURED");
  assert.match(result.error, /14_shared_hosting\.sql/);
  assert.match(result.error, /15_shared_hosting_attempt_state\.sql/);

  // Nothing was claimed, written, activated or probed.
  assert.equal(indexOf(h.calls, "begin"), -1);
  assert.equal(indexOf(h.calls, "createVersion"), -1);
  assert.equal(indexOf(h.calls, "activate"), -1);
});

test("an installed-but-older schema (migration 14 only) is refused as 503", async () => {
  const h = harness({ schema: { ok: true, data: 14 } });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.status, 503);
  assert.equal(result.code, "BACKEND_NOT_CONFIGURED");
  assert.match(result.error, /14_shared_hosting\.sql/);
  assert.match(result.error, /15_shared_hosting_attempt_state\.sql/);
  assert.equal(indexOf(h.calls, "begin"), -1);
});

test("an unrelated database failure is a 500, not a migration error", async () => {
  const h = harness({
    schema: { ok: false, error: "connection reset by peer", code: "08006" },
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.status, 500);
  assert.equal(result.code, "UNKNOWN");
  assert.doesNotMatch(result.error, /migration/i);
  assert.equal(indexOf(h.calls, "begin"), -1);
});

test("activation reporting a missing migration names migration 15 and keeps the old version", async () => {
  const h = harness({
    initial: liveRow("ready", "verified"),
    versions: [["v1", "active"]],
    activate: {
      ok: false,
      error:
        "Shared hosting attempt state is not installed. Apply migration 15_shared_hosting_attempt_state.sql.",
      code: "MIGRATION_REQUIRED",
    },
  });

  const result = await publishSharedVersion(INPUT, h.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.status, 503);
  assert.equal(result.code, "BACKEND_NOT_CONFIGURED");
  assert.match(result.error, /15_shared_hosting_attempt_state\.sql/);
  assert.doesNotMatch(result.error, /14_shared_hosting\.sql/);

  assert.equal(h.state.row.active_version_id, "v1");
  assert.equal(h.state.versions.get("v1"), "active");
  assert.equal(h.state.versions.get("v2"), "failed");
});

test("the migration mapper only attributes missing shared-hosting objects", () => {
  assert.equal(
    requiredMigrationFor({
      code: "42P01",
      message: 'relation "public.project_published_versions" does not exist',
    }),
    "14_shared_hosting.sql",
  );
  assert.equal(
    requiredMigrationFor({
      code: "PGRST202",
      message: "Could not find the function public.activate_shared_publication",
    }),
    "15_shared_hosting_attempt_state.sql",
  );
  assert.equal(
    requiredMigrationFor({
      code: "42P01",
      message: 'relation "public.some_other_feature" does not exist',
    }),
    null,
  );
  assert.equal(requiredMigrationFor({ code: "08006", message: "connection reset" }), null);
  assert.match(
    migrationRequirementMessage("15_shared_hosting_attempt_state.sql"),
    /15_shared_hosting_attempt_state\.sql/,
  );
});
