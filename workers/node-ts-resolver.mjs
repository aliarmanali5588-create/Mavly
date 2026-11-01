import { statSync } from "node:fs";
import {
  dirname,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../src");
const PROJECT_ROOT = resolvePath(SOURCE_ROOT, "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".json"];

function useProjectEsmForTypeScript(resolved) {
  if (!resolved.url.startsWith("file:") || !resolved.url.endsWith(".ts")) {
    return resolved;
  }

  const projectPath = relativePath(PROJECT_ROOT, fileURLToPath(resolved.url));
  if (
    !projectPath ||
    projectPath === ".." ||
    projectPath.startsWith(`..${sep}`) ||
    projectPath.split(sep).includes("node_modules")
  ) {
    return resolved;
  }

  return { ...resolved, format: "module-typescript" };
}

async function resolveWithWorkerFormat(specifier, context, nextResolve) {
  return useProjectEsmForTypeScript(
    await nextResolve(specifier, context),
  );
}

function sourceFileSpecifier(basePath) {
  const candidates = [
    basePath,
    ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => resolvePath(basePath, `index${extension}`)),
  ];
  const existing = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return existing ? pathToFileURL(existing).href : null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier === "next/headers") {
    try {
      return await resolveWithWorkerFormat(specifier, context, nextResolve);
    } catch {
      return resolveWithWorkerFormat(`${specifier}.js`, context, nextResolve);
    }
  }

  if (specifier.startsWith("@/")) {
    const mapped = sourceFileSpecifier(resolvePath(SOURCE_ROOT, specifier.slice(2)));
    if (mapped) return resolveWithWorkerFormat(mapped, context, nextResolve);
  }

  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const parentPath = fileURLToPath(context.parentURL);
    const mapped = sourceFileSpecifier(resolvePath(dirname(parentPath), specifier));
    if (mapped) return resolveWithWorkerFormat(mapped, context, nextResolve);
  }

  return resolveWithWorkerFormat(specifier, context, nextResolve);
}
