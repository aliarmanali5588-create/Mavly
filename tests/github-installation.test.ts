import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRepository,
  listRepositories,
  listUserInstallations,
} from "../src/lib/integrations/github/oauth";
import { githubFailure } from "../src/lib/integrations/github/http";

type FetchCall = { url: string; init?: RequestInit };
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withFetch<T>(
  handler: Handler,
  run: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function installation(
  id: number,
  targetType = "User",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    target_id: id + 1000,
    target_type: targetType,
    account: { login: `account-${id}` },
    repository_selection: "all",
    permissions: { contents: "write", metadata: "read" },
    app_id: 4242,
    app_slug: "mavly-test",
    client_id: "Iv1.test",
    suspended_at: null,
    ...extra,
  };
}

function repository(id: number, updatedAt = "2026-01-01T00:00:00Z"): Record<string, unknown> {
  return {
    id,
    name: `repo-${id}`,
    full_name: `owner/repo-${id}`,
    owner: { login: "owner", type: "User" },
    default_branch: "main",
    private: false,
    updated_at: updatedAt,
  };
}

test("discovery lists each installation and never falls back to /user/repos", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/user/installations?")) {
        return json({
          total_count: 3,
          installations: [
            installation(1, "User", { repository_selection: "selected" }),
            installation(2, "Organization"),
            installation(3, "Organization", { suspended_at: "2026-01-01T00:00:00Z" }),
          ],
        });
      }
      if (url.includes("/user/installations/1/repositories?")) {
        return json({
          total_count: 2,
          repositories: [repository(11, "2026-03-01T00:00:00Z"), repository(12)],
        });
      }
      if (url.includes("/user/installations/2/repositories?")) {
        return json({
          total_count: 2,
          repositories: [repository(12), repository(13, "2026-04-01T00:00:00Z")],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async (calls) => {
      const result = await listRepositories("user-access-token");
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.deepEqual(
        result.data.repositories.map((entry) => entry.id),
        [13, 11, 12],
      );
      assert.equal(result.data.installations.length, 3);
      assert.equal(result.data.installations[0]?.repositorySelection, "selected");
      assert.equal(result.data.installations[0]?.appSlug, "mavly-test");
      assert.equal(result.data.installations[0]?.appId, 4242);
      assert.equal(result.data.installations[2]?.suspended, true);
      assert.equal(
        calls.some((call) => call.url.includes("/user/repos")),
        false,
      );
      assert.equal(
        calls.some((call) => call.url.includes("/user/installations/3/repositories")),
        false,
      );
    },
  );
});

test("an empty selected installation is an empty list, not a failed request", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/user/installations?")) {
        return json({
          total_count: 1,
          installations: [installation(1, "User", { repository_selection: "selected" })],
        });
      }
      if (url.includes("/user/installations/1/repositories?")) {
        return json({ total_count: 0, repositories: [] });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async () => {
      const result = await listRepositories("user-access-token");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.repositories.length, 0);
      assert.equal(result.data.installations[0]?.repositorySelection, "selected");
    },
  );
});

test("installation listing paginates", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => installation(index + 1));
  const secondPage = [installation(101)];

  await withFetch(
    (url) => {
      if (url.endsWith("/user/installations?per_page=100&page=1")) {
        return json({ total_count: 101, installations: firstPage });
      }
      if (url.endsWith("/user/installations?per_page=100&page=2")) {
        return json({ total_count: 101, installations: secondPage });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async (calls) => {
      const result = await listUserInstallations("user-access-token");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.length, 101);
      assert.equal(calls.length, 2);
    },
  );
});

test("repository listing paginates within an installation", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => repository(index + 1));
  const secondPage = [repository(101, "2026-05-01T00:00:00Z")];

  await withFetch(
    (url) => {
      if (url.includes("/user/installations?")) {
        return json({ total_count: 1, installations: [installation(1)] });
      }
      if (url.endsWith("/user/installations/1/repositories?per_page=100&page=1")) {
        return json({ total_count: 101, repositories: firstPage });
      }
      if (url.endsWith("/user/installations/1/repositories?per_page=100&page=2")) {
        return json({ total_count: 101, repositories: secondPage });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async (calls) => {
      const result = await listRepositories("user-access-token");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.repositories.length, 101);
      assert.equal(result.data.repositories[0]?.id, 101);
      assert.equal(
        calls.filter((call) => call.url.includes("/repositories?")).length,
        2,
      );
    },
  );
});

test("a repository-list denial is preserved instead of becoming an empty list", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/user/installations?")) {
        return json({ total_count: 1, installations: [installation(1)] });
      }
      if (url.includes("/user/installations/1/repositories?")) {
        return json(
          { message: "Resource not accessible by integration" },
          403,
          { "x-accepted-github-permissions": "metadata=read" },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async () => {
      const result = await listRepositories("user-access-token");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "github_no_write_permission");
      assert.equal(result.upstream?.status, 403);
      assert.equal(
        result.upstream?.operation,
        "GET /user/installations/1/repositories",
      );
    },
  );
});

test("creation uses the user token on POST /user/repos and keeps GitHub's denial", async () => {
  await withFetch(
    (url, init) => {
      assert.equal(url, "https://api.github.com/user/repos");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer user-access-token");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.name, "new-app");
      assert.equal(body.private, true);
      assert.equal(body.auto_init, false);
      return json(
        { message: "Resource not accessible by integration" },
        403,
        { "x-accepted-github-permissions": "administration=write; repository_creation=write" },
      );
    },
    async (calls) => {
      const result = await createRepository("user-access-token", {
        name: "new-app",
        private: true,
        description: "test",
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "github_no_write_permission");
      assert.equal(result.upstream?.status, 403);
      assert.equal(
        result.upstream?.acceptedPermissions,
        "administration=write; repository_creation=write",
      );
      assert.equal(result.upstream?.operation, "POST /user/repos");
      assert.equal(calls.length, 1);
    },
  );
});

test("permission refusal reports runtime App details without a credential", async () => {
  const response = githubFailure("github_installation_permissions_stale", {
    upstream: {
      status: 403,
      message: "Resource not accessible by integration",
      acceptedPermissions: "administration=write; repository_creation=write",
      operation: "POST /user/repos",
    },
    diagnostics: {
      installationId: 7,
      installationUrl: "https://github.com/settings/installations/7",
      appId: 4242,
      appSlug: "mavly-test",
      clientId: "Iv1.test",
      repositorySelection: "selected",
      permissions: { contents: "write", metadata: "read" },
      suspended: false,
    },
  });

  assert.equal(response.status, 403);
  const body = (await response.json()) as {
    ok: boolean;
    code: string;
    error: string;
    details: Record<string, unknown>;
  };
  assert.equal(body.ok, false);
  assert.equal(body.code, "GITHUB_INSTALLATION_PERMISSIONS_STALE");
  assert.equal(body.details.appId, 4242);
  assert.equal(body.details.appSlug, "mavly-test");
  assert.equal(body.details.installationId, 7);
  assert.equal(body.details.installationUrl, "https://github.com/settings/installations/7");
  assert.equal(body.details.acceptedPermissions, "administration=write; repository_creation=write");
  assert.equal(body.details.operation, "POST /user/repos");

  const raw = JSON.stringify(body);
  assert.equal(/ghu_|ghr_|authorization:\s*bearer|access_token|refresh_token/i.test(raw), false);
});
