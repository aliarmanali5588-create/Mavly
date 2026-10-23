/**
 * Server-only Figma REST client and compact design-context formatter.
 *
 * The only origin used here is `https://api.figma.com`; file keys and node ids
 * come from a parsed Figma link and are placed in fixed paths. The access token
 * is sent in the `X-Figma-Token` header and is never logged or returned.
 *
 * Figma links are references, not instructions. Only the selected frame is read;
 * a file-level link is resolved to its sole top-level node or refused with an
 * actionable error. The model receives a bounded text summary of the layout,
 * typography, colours and copy — not executable content.
 */

import { FIGMA_API_URL, FIGMA_REQUEST_TIMEOUT_MS } from "./config";
import {
  findFigmaUrls,
  parseFigmaUrl,
  type FigmaReference,
} from "@/lib/figma-url";
import type { FigmaAccount } from "@/lib/vcaas-types";

export type { FigmaAccount };

const MAX_API_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_DESIGN_CONTEXT_CHARS = 24_000;
const MAX_NODES = 600;
const MAX_DEPTH = 9;

export type FigmaApiFailureCode =
  | "invalid_token"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "invalid_reference"
  | "missing_node";

export interface FigmaApiFailure {
  ok: false;
  code: FigmaApiFailureCode;
  status: number;
  error: string;
  retryAfterSeconds?: number;
}

export type FigmaApiResult<T> = { ok: true; data: T } | FigmaApiFailure;

export interface FigmaDesign {
  fileKey: string;
  fileName: string;
  lastModified: string | null;
  nodeId: string | null;
  context: string;
}

function apiFailure(
  code: FigmaApiFailureCode,
  status: number,
  error: string,
  retryAfterSeconds?: number,
): FigmaApiFailure {
  return {
    ok: false,
    code,
    status,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function failureFromStatus(
  status: number,
  retryAfterSeconds?: number,
  detail?: string,
): FigmaApiFailure {
  if (status === 401) {
    return apiFailure(
      "invalid_token",
      401,
      "Figma did not accept that access token. It may be expired or revoked.",
    );
  }
  if (status === 403) {
    /**
     * Figma reports an invalid or expired token as 403 on some endpoints, not
     * 401. Its error body distinguishes that from a real permission refusal;
     * showing "check this file's permissions" for a dead token sends the user
     * down the wrong path.
     */
    if (detail && /invalid\s+token|token\s+(?:is\s+)?(?:invalid|expired)|expired\s+token/i.test(detail)) {
      return apiFailure(
        "invalid_token",
        401,
        "Figma did not accept that access token. It may be expired or revoked.",
      );
    }
    return apiFailure(
      "forbidden",
      403,
      "Figma refused access to that design. Check that the token has file_content:read and can read this file.",
    );
  }
  if (status === 400) {
    return apiFailure(
      "invalid_reference",
      400,
      "Figma could not read that selection. Select a smaller frame and try again.",
    );
  }
  if (status === 404) {
    return apiFailure("not_found", 404, "That Figma file or frame could not be found.");
  }
  if (status === 429) {
    return apiFailure(
      "rate_limited",
      429,
      retryAfterSeconds
        ? `Figma is rate-limiting this account. Try again in ${retryAfterSeconds} seconds.`
        : "Figma is rate-limiting this account. Try again shortly.",
      retryAfterSeconds,
    );
  }
  return apiFailure("upstream", 502, "Figma could not be reached right now. Try again.");
}

async function figmaRequest(
  path: string,
  token: string,
): Promise<{ ok: true; text: string } | FigmaApiFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIGMA_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${FIGMA_API_URL}${path}`, {
      method: "GET",
      headers: {
        /**
         * Figma personal access tokens use `X-Figma-Token`, not OAuth's
         * `Authorization: Bearer`. Sending the wrong header makes a valid token
         * look rejected.
         */
        "x-figma-token": token,
        accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const detail = await response.text().catch(() => "");
      return failureFromStatus(
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.floor(retryAfter) : undefined,
        detail.slice(0, 2_000),
      );
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_API_RESPONSE_BYTES) {
      return apiFailure(
        "upstream",
        502,
        "That Figma selection is too large to read. Select one frame and try again.",
      );
    }
    return { ok: true, text };
  } catch {
    return apiFailure(
      "upstream",
      502,
      controller.signal.aborted
        ? "Figma did not answer in time. Try again."
        : "Figma could not be reached right now. Try again.",
    );
  } finally {
    clearTimeout(timer);
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return recordOf(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function getFigmaMe(token: string): Promise<FigmaApiResult<FigmaAccount>> {
  const response = await figmaRequest("/v1/me", token);
  if (response.ok === false) {
    if (response.code === "forbidden" || response.code === "invalid_reference") {
      return apiFailure(
        "invalid_token",
        401,
        "Figma did not accept that access token, or it is missing the current_user:read scope.",
      );
    }
    return response;
  }

  const body = parseJsonObject(response.text);
  const id = stringOf(body?.id)?.trim();
  const handle = stringOf(body?.handle)?.trim();
  if (!id || !handle) {
    return apiFailure("upstream", 502, "Figma returned an unexpected account response.");
  }

  const email = stringOf(body?.email)?.trim();
  const imgUrl = stringOf(body?.img_url)?.trim();
  return {
    ok: true,
    data: {
      id: id.slice(0, 200),
      handle: handle.slice(0, 200),
      ...(email ? { email: email.slice(0, 320) } : {}),
      ...(imgUrl ? { imgUrl: imgUrl.slice(0, 2_000) } : {}),
    },
  };
}

/* ─────────────────────────── Link parsing ─────────────────────────── */

export function extractFigmaReferences(
  prompt: string,
): FigmaApiResult<FigmaReference[]> {
  const matches = findFigmaUrls(prompt);
  if (matches.length === 0) return { ok: true, data: [] };

  const references: FigmaReference[] = [];
  const seen = new Set<string>();

  for (const raw of matches) {
    const reference = parseFigmaUrl(raw);
    if (!reference) {
      return apiFailure(
        "invalid_reference",
        400,
        "That doesn't look like a Figma design link. Copy a frame link from Figma and try again.",
      );
    }

    const key = `${reference.fileKey}:${reference.nodeId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push(reference);
    }
    if (references.length >= 2) break;
  }

  return { ok: true, data: references };
}

/* ─────────────────────────── Design reading ─────────────────────────── */

export async function getFigmaDesign(
  token: string,
  reference: FigmaReference,
): Promise<FigmaApiResult<FigmaDesign>> {
  const key = encodeURIComponent(reference.fileKey);
  const nodeId = reference.nodeId;

  if (nodeId) {
    const query = new URLSearchParams({ ids: nodeId, depth: "8" });
    const response = await figmaRequest(`/v1/files/${key}/nodes?${query}`, token);
    if (response.ok === false) return response;

    const body = parseJsonObject(response.text);
    const fileName = stringOf(body?.name)?.trim() || "Figma file";
    const lastModified = stringOf(body?.lastModified)?.trim() ?? null;
    const nodes = recordOf(body?.nodes);
    const entry = recordOf(nodes?.[nodeId]);
    const document = recordOf(entry?.document);

    if (!document) {
      return apiFailure(
        "missing_node",
        400,
        "That Figma frame could not be found. Open the frame in Figma, copy its link again, and retry.",
      );
    }

    return {
      ok: true,
      data: {
        fileKey: reference.fileKey,
        fileName,
        lastModified,
        nodeId,
        context: formatNodeTree(document, fileName, reference),
      },
    };
  }

  /**
   * ⚠️ A FILE LINK IS NOT A DESIGN. Do not send a page/frame index to the model:
   * a name like "Task list" from another frame is enough for it to invent an app
   * the user never selected. Resolve the file only when it has exactly one
   * top-level design; otherwise ask for the frame link.
   */
  const response = await figmaRequest(`/v1/files/${key}?depth=3`, token);
  if (response.ok === false) return response;

  const body = parseJsonObject(response.text);
  const fileName = stringOf(body?.name)?.trim() || "Figma file";
  const document = recordOf(body?.document);
  if (!document) {
    return apiFailure("upstream", 502, "Figma returned an unexpected file response.");
  }

  const candidates = topLevelNodes(document);
  if (candidates.length === 1) {
    return getFigmaDesign(token, { ...reference, nodeId: candidates[0].id });
  }
  if (candidates.length === 0) {
    return apiFailure(
      "invalid_reference",
      400,
      `The Figma file "${truncate(fileName, 80)}" has no top-level design to read. Open the frame you want, right-click it, and choose "Copy link to selection".`,
    );
  }

  const names = candidates
    .slice(0, 5)
    .map((candidate) => `"${truncate(candidate.name, 60)}" [${candidate.id}]`)
    .join(", ");
  const more = candidates.length > 5 ? `, and ${candidates.length - 5} more` : "";
  return apiFailure(
    "invalid_reference",
    400,
    `That Figma link points to a whole file, not a frame. Open the frame you want, right-click it, and choose "Copy link to selection". Top-level designs found: ${names}${more}.`,
  );
}

/* ─────────────────────────── Formatting ─────────────────────────── */

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function colorHex(value: unknown): string | null {
  const color = recordOf(value);
  if (!color) return null;
  const r = numberValue(color.r);
  const g = numberValue(color.g);
  const b = numberValue(color.b);
  if (r === null || g === null || b === null) return null;
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  const alpha = numberValue(color.a);
  return `#${channel(r)}${channel(g)}${channel(b)}${alpha !== null && alpha < 1 ? ` (${round(alpha, 2)})` : ""}`;
}

function paintSummary(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paints: string[] = [];

  for (const raw of value.slice(0, 3)) {
    const paint = recordOf(raw);
    if (!paint || paint.visible === false) continue;
    const type = stringOf(paint.type) ?? "PAINT";
    if (type === "SOLID") {
      const hex = colorHex(paint.color);
      if (hex) paints.push(hex);
    } else if (type.startsWith("GRADIENT_")) {
      paints.push(type.toLowerCase().replaceAll("_", " "));
    } else if (type === "IMAGE") {
      paints.push("image fill");
    }
  }

  return paints.length > 0 ? paints.join(" / ") : null;
}

function effectSummary(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const effects: string[] = [];

  for (const raw of value.slice(0, 2)) {
    const effect = recordOf(raw);
    if (!effect || effect.visible === false) continue;
    const type = stringOf(effect.type);
    if (!type) continue;
    if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
      const offset = recordOf(effect.offset);
      const x = numberValue(offset?.x) ?? 0;
      const y = numberValue(offset?.y) ?? 0;
      const radius = numberValue(effect.radius);
      const hex = colorHex(effect.color);
      effects.push(
        `${type.toLowerCase().replaceAll("_", " ")} ${round(x)}px ${round(y)}px${radius === null ? "" : ` ${round(radius)}px blur`}${hex ? ` ${hex}` : ""}`,
      );
    } else if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
      const radius = numberValue(effect.radius);
      effects.push(`${type.toLowerCase().replaceAll("_", " ")}${radius === null ? "" : ` ${round(radius)}px`}`);
    }
  }

  return effects.length > 0 ? effects.join(", ") : null;
}

function sizeOf(node: Record<string, unknown>): string | null {
  const box = recordOf(node.absoluteBoundingBox);
  const width = numberValue(box?.width);
  const height = numberValue(box?.height);
  if (width === null || height === null) return null;
  return `${round(width)}×${round(height)}`;
}

function layoutGridSummary(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const grids: string[] = [];
  for (const raw of value.slice(0, 2)) {
    const grid = recordOf(raw);
    if (!grid || grid.visible === false) continue;
    const pattern = stringOf(grid.pattern) ?? "GRID";
    const parts = [pattern.toLowerCase()];
    const count = numberValue(grid.count);
    const section = numberValue(grid.sectionSize);
    const gutter = numberValue(grid.gutterSize);
    const offset = numberValue(grid.offset);
    const alignment = stringOf(grid.alignment);
    if (count !== null) parts.push(`count=${round(count)}`);
    if (section !== null) parts.push(`size=${round(section)}`);
    if (gutter !== null) parts.push(`gutter=${round(gutter)}`);
    if (offset !== null) parts.push(`offset=${round(offset)}`);
    if (alignment) parts.push(`align=${alignment.toLowerCase()}`);
    const color = colorHex(grid.color);
    if (color) parts.push(`color=${color}`);
    grids.push(parts.join(" "));
  }
  return grids.length ? grids.join(" / ") : null;
}

function componentPropertySummary(value: unknown): string | null {
  const properties = recordOf(value);
  if (!properties) return null;
  const parts: string[] = [];
  for (const [name, raw] of Object.entries(properties).slice(0, 6)) {
    const property = recordOf(raw);
    const rawValue = property ? property.value : raw;
    const text =
      typeof rawValue === "string"
        ? rawValue
        : typeof rawValue === "boolean"
          ? String(rawValue)
          : "";
    if (!text) continue;
    parts.push(`${truncate(name, 40)}=${truncate(text, 60)}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function describeNode(node: Record<string, unknown>): string {
  const type = stringOf(node.type) ?? "NODE";
  const name = truncate(stringOf(node.name) ?? "", 90);
  const parts: string[] = [type, `"${name}"`];

  const size = sizeOf(node);
  if (size) parts.push(size);
  if (node.visible === false) parts.push("hidden");

  const layoutMode = stringOf(node.layoutMode);
  if (layoutMode && layoutMode !== "NONE") {
    parts.push(`layout=${layoutMode.toLowerCase()}`);
    const gap = numberValue(node.itemSpacing);
    if (gap !== null && gap > 0) parts.push(`gap=${round(gap)}`);
    const primary = stringOf(node.primaryAxisAlignItems);
    const counter = stringOf(node.counterAxisAlignItems);
    if (primary) parts.push(`align-main=${primary.toLowerCase()}`);
    if (counter) parts.push(`align-cross=${counter.toLowerCase()}`);
  }

  const sizingHorizontal = stringOf(node.layoutSizingHorizontal);
  const sizingVertical = stringOf(node.layoutSizingVertical);
  if (sizingHorizontal || sizingVertical) {
    parts.push(
      `sizing=${(sizingHorizontal ?? "?").toLowerCase()}/${(sizingVertical ?? "?").toLowerCase()}`,
    );
  }

  const padding = [
    ["top", numberValue(node.paddingTop)],
    ["right", numberValue(node.paddingRight)],
    ["bottom", numberValue(node.paddingBottom)],
    ["left", numberValue(node.paddingLeft)],
  ] as const;
  const presentPadding = padding.filter(([, value]) => value !== null && value > 0);
  if (presentPadding.length > 0) {
    parts.push(
      `padding=${presentPadding.map(([side, value]) => `${side[0]}${round(value as number)}`).join(" ")}`,
    );
  }

  const grids = layoutGridSummary(node.layoutGrids);
  if (grids) parts.push(`layout-grids=${grids}`);

  const constraints = recordOf(node.constraints);
  const horizontal = stringOf(constraints?.horizontal);
  const vertical = stringOf(constraints?.vertical);
  if (horizontal || vertical) {
    parts.push(
      `constraints=${(horizontal ?? "?").toLowerCase()}/${(vertical ?? "?").toLowerCase()}`,
    );
  }

  const radius = numberValue(node.cornerRadius);
  const radii = Array.isArray(node.rectangleCornerRadii)
    ? node.rectangleCornerRadii.filter((entry): entry is number => typeof entry === "number")
    : [];
  if (radius !== null && radius > 0) parts.push(`radius=${round(radius)}`);
  else if (radii.some((value) => value > 0)) {
    parts.push(`radii=${radii.map((value) => round(value)).join("/")}`);
  }

  const fills = paintSummary(node.fills);
  if (fills) parts.push(`fill=${fills}`);
  const strokes = paintSummary(node.strokes);
  if (strokes) {
    const weight = numberValue(node.strokeWeight);
    parts.push(`stroke=${strokes}${weight !== null ? `@${round(weight)}` : ""}`);
  }

  const opacity = numberValue(node.opacity);
  if (opacity !== null && opacity < 1) parts.push(`opacity=${round(opacity, 2)}`);
  const effects = effectSummary(node.effects);
  if (effects) parts.push(`effects=${effects}`);

  /**
   * REST text nodes carry typography in `style`; the plugin-shaped `fontName`
   * fields are kept as a fallback so both payload shapes are understood.
   */
  const style = recordOf(node.style);
  const font = recordOf(node.fontName);
  const fontFamily = stringOf(style?.fontFamily) ?? stringOf(font?.family);
  const fontStyle =
    stringOf(font?.style) ??
    stringOf(style?.fontPostScriptName);
  const fontSize = numberValue(style?.fontSize) ?? numberValue(node.fontSize);
  const fontWeight = numberValue(style?.fontWeight);
  const characters = stringOf(node.characters);
  if (fontSize !== null) parts.push(`font=${round(fontSize)}px`);
  if (fontFamily) {
    parts.push(
      `family="${truncate(fontFamily, 60)}${fontStyle ? ` ${truncate(fontStyle, 40)}` : ""}"`,
    );
  }
  if (fontWeight !== null && fontWeight !== 400) {
    parts.push(`font-weight=${round(fontWeight)}`);
  }
  const lineHeight = numberValue(style?.lineHeightPx) ?? numberValue(node.lineHeightPx);
  if (lineHeight !== null) parts.push(`line-height=${round(lineHeight)}`);
  const letterSpacing =
    numberValue(style?.letterSpacing) ?? numberValue(node.letterSpacing);
  if (letterSpacing !== null && letterSpacing !== 0) {
    parts.push(`letter-spacing=${round(letterSpacing, 2)}`);
  }
  const align =
    stringOf(style?.textAlignHorizontal) ?? stringOf(node.textAlignHorizontal);
  if (align) parts.push(`text-align=${align.toLowerCase()}`);
  const textCase = stringOf(style?.textCase) ?? stringOf(node.textCase);
  if (textCase && textCase !== "ORIGINAL") {
    parts.push(`text-case=${textCase.toLowerCase()}`);
  }

  if (characters !== null) {
    parts.push(`text="${truncate(characters, 220)}"`);
  }

  const properties = componentPropertySummary(node.componentProperties);
  if (properties) parts.push(`component-properties=${properties}`);

  return parts.join(" ");
}

function childNodes(node: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(node.children)) return [];
  return node.children
    .map((child) => recordOf(child))
    .filter((child): child is Record<string, unknown> => child !== null);
}

/**
 * Find the design surfaces a file link could mean. Pages are traversed, and
 * sections/groups/component sets are descended so a container holding several
 * frames or variants is ambiguous rather than silently treated as one screen.
 * Frames/components are not descended: their children belong to the selected
 * design, not to a list of sibling screens. This only answers "is there exactly
 * one obvious design?", never "list everything so the model can guess".
 */
function topLevelNodes(
  document: Record<string, unknown>,
): { id: string; name: string }[] {
  const nodes: { id: string; name: string }[] = [];

  const visit = (parent: Record<string, unknown>, depth: number): void => {
    if (depth > 8) return;
    for (const child of childNodes(parent)) {
      const id = stringOf(child.id)?.trim();
      if (!id) continue;
      const type = stringOf(child.type);
      if (type === "CANVAS") {
        visit(child, depth + 1);
        continue;
      }
      if (type === "SECTION" || type === "GROUP" || type === "COMPONENT_SET") {
        const before = nodes.length;
        visit(child, depth + 1);
        if (nodes.length === before) {
          nodes.push({ id, name: stringOf(child.name)?.trim() || id });
        }
        continue;
      }
      nodes.push({ id, name: stringOf(child.name)?.trim() || id });
    }
  };

  visit(document, 0);
  return nodes;
}

function formatNodeTree(
  root: Record<string, unknown>,
  fileName: string,
  reference: FigmaReference,
): string {
  const lines: string[] = [
    `Figma design reference (read from the user's Figma account)`,
    `File: ${truncate(fileName, 160)}`,
    `Selected frame: ${reference.nodeId}`,
    `This is the selected frame's layer tree, read through the Figma REST API. Only the layers listed below are part of the reference.`,
    `Do not invent additional sections, controls, copy, or imagery, and do not infer content from the file or frame name.`,
    `Layout, typography and paint values below describe that frame. Treat them as design intent, not code.`,
    `Image fills are reported only as "image fill"; their pixels are not included.`,
    "",
  ];

  let nodes = 0;
  let chars = lines.join("\n").length;
  let truncated = false;

  const walk = (node: Record<string, unknown>, depth: number): void => {
    if (truncated) return;
    if (nodes >= MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }

    nodes += 1;
    const line = `${"  ".repeat(Math.min(depth, MAX_DEPTH))}- ${describeNode(node)}`;
    if (chars + line.length + 1 > MAX_DESIGN_CONTEXT_CHARS) {
      truncated = true;
      return;
    }
    lines.push(line);
    chars += line.length + 1;

    for (const child of childNodes(node)) {
      if (truncated) return;
      walk(child, depth + 1);
    }
  };

  walk(root, 0);
  if (truncated) {
    lines.push(
      `[Design summary truncated at ${nodes} layers. The frame is larger; select a smaller frame for more detail.]`,
    );
  }
  return lines.join("\n");
}
