/**
 * Pure Figma URL parsing, shared by the composer and the server.
 *
 * A Figma link is a reference to a file and, optionally, one frame. The host is
 * compared exactly (never with a substring check) and only Figma file links
 * (design, file, proto, FigJam board, slides) are accepted. The file key is later placed in a fixed Figma API path, so
 * it is constrained to the characters Figma uses.
 */

/** Any Figma URL; `parseFigmaUrl` decides whether it is a readable file link. */
const FIGMA_URL_PATTERN = /https?:\/\/(?:www\.)?figma\.com\/[^\s<>"']+/gi;
const FIGMA_FILE_KINDS = new Set(["design", "file", "proto", "board", "slides"]);
const FIGMA_FILE_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const FIGMA_NODE_ID = /^\d+[:-]\d+$/;

export interface FigmaReference {
  url: string;
  fileKey: string;
  nodeId: string | null;
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[)\]}.,;!?`]+$/g, "");
}

export function parseFigmaUrl(raw: string): FigmaReference | null {
  let url: URL;
  try {
    url = new URL(trimUrlPunctuation(raw));
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "figma.com" && host !== "www.figma.com") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const kind = segments[0]?.toLowerCase();
  if (!kind || !FIGMA_FILE_KINDS.has(kind)) return null;

  const fileKey = segments[1];
  if (!fileKey || !FIGMA_FILE_KEY.test(fileKey)) return null;

  const rawNodeId = url.searchParams.get("node-id");
  let nodeId: string | null = null;
  if (rawNodeId) {
    if (!FIGMA_NODE_ID.test(rawNodeId)) return null;
    nodeId = rawNodeId.replace("-", ":");
  }

  return { url: url.toString(), fileKey, nodeId };
}

export function isFigmaUrl(value: string): boolean {
  return parseFigmaUrl(value) !== null;
}

/** Every Figma URL in a prompt, trimmed and in order. */
export function findFigmaUrls(text: string): string[] {
  return (text.match(FIGMA_URL_PATTERN) ?? []).map(trimUrlPunctuation);
}
