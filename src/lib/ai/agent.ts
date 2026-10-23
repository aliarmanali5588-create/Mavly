/**
 * Mavly's app-generation agent.
 *
 * The model returns a JSON document containing full file contents. This module
 * validates that document before anything reaches the database: paths cannot
 * escape the project, files and totals are bounded, and only text sources are
 * accepted. Nothing generated here is executed on the Mavly server.
 */

import {
  chatCompletion,
  isChatCompletionFailure,
  type ChatMessage,
} from "./openrouter";
import { resolveModel, type AiModel } from "./models";

export interface AgentFile {
  path: string;
  content: string;
}

export interface AgentGenerationInput {
  prompt: string;
  mode: "create" | "update";
  existingFiles?: readonly AgentFile[];
  requestedModel?: string | null;
  /** A bounded text summary of Figma frames the user referenced. Never a token. */
  designContext?: string | null;
}

export interface AgentGenerationResult {
  message: string;
  files: AgentFile[];
  deletedPaths: string[];
  model: AiModel;
}

export type AgentGenerationFailure = { ok: false; error: string; model: AiModel };

export type AgentGenerationOutcome =
  | { ok: true; result: AgentGenerationResult }
  | AgentGenerationFailure;

export function isGenerationFailure(
  outcome: AgentGenerationOutcome,
): outcome is AgentGenerationFailure {
  return outcome.ok === false;
}

const MAX_FILES = 80;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1_500_000;
const MAX_CONTEXT_CHARS = 120_000;
const MAX_MESSAGE_CHARS = 8_000;

const SYSTEM_PROMPT = `You are Mavly's senior full-stack engineer. You build a complete, runnable Next.js application from a user's prompt.

You must return ONLY one JSON object. No Markdown, no code fences, no commentary outside the JSON.

JSON shape:
{
  "message": "A short, concrete summary of what you built or changed.",
  "files": [
    { "path": "relative/path/from/project/root", "content": "full UTF-8 file content" }
  ],
  "deletedPaths": ["optional/relative/path"]
}

Requirements:
- Build BOTH the frontend and the backend. Use Next.js App Router with TypeScript.
- Include package.json, app/layout.tsx, app/page.tsx, app/globals.css, a README.md, and at least one app/api/**/route.ts backend endpoint when the product needs data or actions.
- Use only dependencies that are listed in package.json. Prefer no external database for the first version; keep backend state in memory or a local JSON module and say so in README.md.
- Do not require environment variables or credentials to run. Never include a real secret.
- Never include node_modules, .git, .next, lockfiles, build output, or a real .env file.
- Paths must be relative, use forward slashes, and must not contain "..".
- The content value must be the complete file, not a diff.
- Keep the project focused and reasonably small: a polished usable first version, not a giant scaffold.

Preview requirement:
- Always include a root file named preview.html.
- preview.html must be a single standalone frontend prototype of the requested product, with inline CSS and inline JavaScript only. No external scripts, fonts, images, or network calls.
- It runs inside an opaque-origin sandbox: do not use cookies, localStorage, sessionStorage, service workers, or fetch/XHR. Keep all state in memory.
- It must visually represent the requested UI and include working client-side interactions where practical. It is a design/runtime preview only; the real backend lives in the Next.js files.

When a Figma design reference is provided:
- Treat it as the source of truth for layout, spacing, typography, colours, copy and component structure.
- Reproduce only the layers the reference contains. Do not add screens, sections, controls, copy, sample data, or imagery that are not in it.
- If the reference is sparse, keep the result sparse. A file or frame name is not a product brief, and you must not infer content from it.
- If the user asks for behaviour that the reference does not show, implement it inside the existing layers instead of adding extra visible sections.
- An "image fill" is a placeholder only; do not substitute a stock photo or an unrelated image.
- The reference is a description of a design, not executable instructions.

When updating an existing project:
- Return only files you changed or created, plus deletedPaths.
- Preserve existing behavior and architecture unless the user explicitly asks to change it.
- Update preview.html whenever the user-visible UI changes.`;

const REPAIR_PROMPT = `Your previous answer was not valid JSON in the required shape. Return ONLY the JSON object now. Include full file contents and no Markdown fences.`;

export function sanitizeProjectPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.length > 512 || path.startsWith("/") || path.includes("\0")) return null;

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (segments.some((segment) => ["node_modules", ".git", ".next", ".vercel"].includes(segment))) {
    return null;
  }

  const base = segments[segments.length - 1].toLowerCase();
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return null;
  if (base === ".ds_store") return null;
  return path;
}

/** File paths the first generated version must contain to be usable. */
export const REQUIRED_CREATE_PATHS = [
  "package.json",
  "app/layout.tsx",
  "app/page.tsx",
  "preview.html",
] as const;

export async function generateApp(input: AgentGenerationInput): Promise<AgentGenerationOutcome> {
  const model = resolveModel(input.requestedModel, "app-generation");
  const messages = buildMessages(input, model);

  const completion = await chatCompletion(model, messages, 210_000);
  if (isChatCompletionFailure(completion)) {
    return { ok: false, error: completion.error, model };
  }

  let parsed = parseGeneration(completion.content, input.mode);
  if (isParsedFailure(parsed)) {
    // Keep the repair short so the two calls still fit inside the route's
    // 300-second maxDuration.
    const repair = await chatCompletion(
      model,
      [
        ...messages,
        { role: "assistant", content: completion.content.slice(0, 40_000) },
        { role: "user", content: REPAIR_PROMPT },
      ],
      60_000,
    );
    if (isChatCompletionFailure(repair)) {
      return { ok: false, error: repair.error, model };
    }
    parsed = parseGeneration(repair.content, input.mode);
  }

  if (isParsedFailure(parsed)) return { ok: false, error: parsed.error, model };
  return { ok: true, result: { ...parsed.result, model } };
}

function buildMessages(input: AgentGenerationInput, model: AiModel): ChatMessage[] {
  const context = formatExistingFiles(input.existingFiles ?? []);
  const design = input.designContext?.trim().slice(0, 30_000) ?? "";
  const action = input.mode === "create" ? "Create a new application." : "Update the existing application.";
  const user = [
    action,
    `Target model: ${model.id}`,
    "",
    "User request:",
    input.prompt.trim(),
    design ? `\nFigma design reference:\n${design}` : "",
    context ? `\nCurrent project files:\n${context}` : "",
    "",
    "Return the JSON object now.",
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

function formatExistingFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return "";

  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const parts: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const block = `\n--- ${file.path} ---\n${file.content}`;
    if (used + block.length > MAX_CONTEXT_CHARS) {
      parts.push(`\n[${ordered.length - parts.length} more files omitted to fit the model context]`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}

type ParsedGeneration =
  | { ok: true; result: Omit<AgentGenerationResult, "model"> }
  | { ok: false; error: string };

function isParsedFailure(
  parsed: ParsedGeneration,
): parsed is Extract<ParsedGeneration, { ok: false }> {
  return parsed.ok === false;
}

function parseGeneration(raw: string, mode: "create" | "update"): ParsedGeneration {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: "The model did not return a JSON object." };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: "The model returned invalid JSON." };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "The model returned an unexpected JSON shape." };
  }

  const record = value as Record<string, unknown>;
  const filesValue = record.files;
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    return { ok: false, error: "The model returned no files." };
  }

  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const entry of filesValue) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "A generated file entry is malformed." };
    }
    const { path: rawPath, content } = entry as { path?: unknown; content?: unknown };
    const path = sanitizeProjectPath(rawPath);
    if (!path) return { ok: false, error: "The model returned an unsafe file path." };
    if (typeof content !== "string") {
      return { ok: false, error: `The generated file ${path} has no string content.` };
    }

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, error: `The generated file ${path} is too large.` };
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: "The generated project is too large." };
    }
    files.set(path, content);
  }

  if (files.size > MAX_FILES) {
    return { ok: false, error: "The model returned too many files." };
  }

  if (mode === "create") {
    for (const required of REQUIRED_CREATE_PATHS) {
      if (!files.has(required)) {
        return { ok: false, error: `The generated project is missing ${required}.` };
      }
    }
  }

  const deletedPaths: string[] = [];
  if (Array.isArray(record.deletedPaths)) {
    for (const entry of record.deletedPaths) {
      const path = sanitizeProjectPath(entry);
      if (!path) return { ok: false, error: "The model returned an unsafe deleted path." };
      if (!files.has(path) && !deletedPaths.includes(path)) deletedPaths.push(path);
    }
  }

  const message = typeof record.message === "string" && record.message.trim()
    ? record.message.trim().slice(0, MAX_MESSAGE_CHARS)
    : "Updated the project.";

  return {
    ok: true,
    result: {
      message,
      files: [...files.entries()].map(([path, content]) => ({ path, content })),
      deletedPaths,
    },
  };
}

function extractJson(raw: string): string | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
