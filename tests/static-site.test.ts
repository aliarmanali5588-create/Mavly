import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveStaticPreview,
  staticPreviewPath,
  staticPublishFiles,
} from "../src/lib/static-site";

const file = (path: string, content = "") => ({ path, content });

test("the generated preview wins over imported html", () => {
  const resolved = resolveStaticPreview([
    file("preview.html", "<html></html>"),
    file("index.html", "<html></html>"),
  ]);
  assert.equal(resolved.site?.entryPath, "preview.html");
  assert.equal(resolved.site?.generated, true);
});

test("a root index.html is a static site", () => {
  const resolved = resolveStaticPreview([
    file("index.html", "<link rel=\"stylesheet\" href=\"style.css\">"),
    file("style.css", "body{}"),
  ]);
  assert.equal(resolved.site?.entryPath, "index.html");
  assert.equal(resolved.unsupported, false);
});

test("public/index.html resolves assets under public", () => {
  const resolved = resolveStaticPreview([file("public/index.html", "<p>hi</p>")]);
  assert.equal(resolved.site?.entryPath, "public/index.html");
  assert.equal(resolved.site?.root, "public");
  assert.equal(staticPreviewPath(resolved.site!, "assets/app.js"), "public/assets/app.js");
});

test("a TypeScript entry is reported as needing a build", () => {
  const resolved = resolveStaticPreview([
    file("index.html", '<script type="module" src="/src/main.tsx"></script>'),
  ]);
  assert.equal(resolved.site, null);
  assert.equal(resolved.unsupported, true);
});

test("a framework repository without an index is reported as needing a build", () => {
  const resolved = resolveStaticPreview([
    file("package.json", JSON.stringify({ dependencies: { next: "16.0.0" } })),
    file("app/page.tsx", "export default function Page() { return null; }"),
  ]);
  assert.equal(resolved.site, null);
  assert.equal(resolved.unsupported, true);
  assert.match(resolved.reason, /Next\.js/);
});

test("a static site that loads /main.js is not mistaken for a framework app", () => {
  const resolved = resolveStaticPreview([
    file("index.html", '<script src="/main.js"></script>'),
    file("main.js", "console.log('ok');"),
  ]);
  assert.equal(resolved.site?.entryPath, "index.html");
  assert.equal(resolved.unsupported, false);
});

test("a Vite index that points at /src/main.js is still reported as needing a build", () => {
  const resolved = resolveStaticPreview([
    file("package.json", JSON.stringify({ devDependencies: { vite: "7.0.0" } })),
    file("index.html", '<script type="module" src="/src/main.js"></script>'),
  ]);
  assert.equal(resolved.site, null);
  assert.equal(resolved.unsupported, true);
});

test("path traversal is refused", () => {
  const resolved = resolveStaticPreview([file("index.html", "<p>hi</p>")]);
  assert.equal(staticPreviewPath(resolved.site!, "../.env"), null);
  assert.equal(staticPreviewPath(resolved.site!, "a/../../b"), null);
});

test("publishing maps the entry to index.html and drops files outside the root", () => {
  const resolved = resolveStaticPreview([file("public/index.html", "<p>hi</p>")]);
  const files = staticPublishFiles(
    [
      file("public/index.html", "<p>hi</p>"),
      file("public/style.css", "body{}"),
      file("src/main.ts", "no"),
    ],
    resolved.site!,
  );
  assert.deepEqual(files.map((entry) => entry.path), ["index.html", "style.css"]);
});
