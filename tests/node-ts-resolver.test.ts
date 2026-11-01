import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolve } from "../workers/node-ts-resolver.mjs";

const PROJECT_ROOT = resolvePath(
  fileURLToPath(new URL("..", import.meta.url)),
);
const context = {
  parentURL: pathToFileURL(
    resolvePath(PROJECT_ROOT, "workers/render-generation-worker.ts"),
  ).href,
};

test("project TypeScript files use Node's native TypeScript module format", async () => {
  const resolved = await resolve(
    "./workers/aws-generation-worker.ts",
    context,
    async (specifier) => ({
      url: pathToFileURL(resolvePath(PROJECT_ROOT, specifier)).href,
      format: "module",
    }),
  );

  assert.equal(resolved.format, "module-typescript");
});

test("the @ alias continues to resolve project TypeScript files", async () => {
  const resolved = await resolve(
    "@/lib/generation/worker",
    context,
    async (specifier) => ({
      url: specifier,
      format: "module",
    }),
  );

  assert.equal(
    fileURLToPath(resolved.url),
    resolvePath(PROJECT_ROOT, "src/lib/generation/worker.ts"),
  );
  assert.equal(resolved.format, "module-typescript");
});

test("extensionless relative imports continue to resolve project TypeScript files", async () => {
  const resolved = await resolve(
    "./aws-generation-worker",
    context,
    async (specifier) => ({
      url: specifier,
      format: "module",
    }),
  );

  assert.equal(
    fileURLToPath(resolved.url),
    resolvePath(PROJECT_ROOT, "workers/aws-generation-worker.ts"),
  );
  assert.equal(resolved.format, "module-typescript");
});

test("TypeScript files in node_modules keep Node's resolved format", async () => {
  const dependencyUrl = pathToFileURL(
    resolvePath(PROJECT_ROOT, "node_modules/example-package/index.ts"),
  ).href;
  const resolved = await resolve("example-package", context, async () => ({
    url: dependencyUrl,
    format: "commonjs",
  }));

  assert.equal(resolved.url, dependencyUrl);
  assert.equal(resolved.format, "commonjs");
});

test("Next server subpaths keep the .js compatibility fallback", async () => {
  const attempts = [];
  const resolved = await resolve("next/server", context, async (specifier) => {
    attempts.push(specifier);
    if (specifier === "next/server") throw new Error("subpath has no direct resolution");
    return {
      url: pathToFileURL(resolvePath(PROJECT_ROOT, "node_modules/next/server.js")).href,
      format: "module",
    };
  });

  assert.deepEqual(attempts, ["next/server", "next/server.js"]);
  assert.equal(resolved.format, "module");
});
