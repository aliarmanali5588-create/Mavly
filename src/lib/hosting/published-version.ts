/**
 * ═══ PUBLISHED-VERSION RULES (PURE) ═════════════════════════════════════════
 *
 * These functions describe what an immutable published version contains and how
 * a request path maps onto it. They are deliberately free of Next, Supabase and
 * environment access so the serving rules can be tested directly.
 *
 * ⚠️ A PUBLISHED VERSION IS NOT `project_files`. The version is a frozen copy of
 * exactly what one publish released; editing the project later must never change
 * what the version serves.
 */

/**
 * Content types for the static files Mavly can publish.
 *
 * ⚠️ TEXT ONLY. `project_files.content` is a text column and the publish path
 * uploads `Buffer.from(content, "utf8")`, so a "binary" asset is stored as its
 * text representation. The map is therefore about correct DELIVERY of the text
 * formats a generated or imported static site actually uses (HTML, CSS, JS,
 * SVG, JSON, fonts referenced as data, …), not a claim that arbitrary binaries
 * round-trip.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Validate one decoded request segment.
 *
 * Next hands route params over already percent-decoded, but a decoded `%2e%2e`
 * arrives as `..`, so the check runs on the DECODED value. Cross-platform
 * separators and control characters are refused; a leading slash or an absolute
 * path can never appear because segments are joined by this module.
 */
export function isSafePublishedSegment(segment: string): boolean {
  if (!segment || segment.length > 255) return false;
  if (segment === "." || segment === "..") return false;
  if (/[\u0000-\u001f/\\]/.test(segment)) return false;
  return true;
}

/**
 * Map decoded request segments onto a published file path.
 *
 * Returns `null` for anything that could escape the version. The empty path and
 * `index.html` both mean the version's entry document.
 */
export function publishedPathFromSegments(
  segments: readonly string[],
  entryPath: string,
): string | null {
  if (segments.length === 0) return entryPath;

  for (const segment of segments) {
    if (!isSafePublishedSegment(segment)) return null;
  }

  const joined = segments.join("/");
  if (!joined || joined === "index.html") return entryPath;
  return joined;
}

export interface PublishedLookup {
  /** The exact version-relative path to read. */
  path: string;
  /** True when this is the SPA fallback rather than the literal path. */
  fallback: boolean;
}

/**
 * Decide which paths to try for a request, in order.
 *
 * ⚠️ SPA FALLBACK IS POLICY, NOT A DEFAULT. A generated `preview.html` is a
 * single self-contained document whose in-page navigation is client-side, so a
 * deep link that reloads must serve that document (the site's manifest records
 * `spa_fallback = true` when it was published from the generated preview). An
 * imported multi-page site keeps literal 404s for unknown paths; falling back
 * would turn every typo into a 200 duplicate of the homepage.
 *
 * A trailing-slash request (`/blog/`) also tries `blog/index.html`, which is how
 * static hosts commonly lay directories out. Both fallbacks are explicit and
 * bounded; neither can escape the version.
 */
export function publishedLookupCandidates(
  segments: readonly string[],
  entryPath: string,
  spaFallback: boolean,
): PublishedLookup[] {
  const primary = publishedPathFromSegments(segments, entryPath);
  if (!primary) return [];

  const candidates: PublishedLookup[] = [{ path: primary, fallback: false }];

  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    // `/blog` → `blog/index.html`
    if (last && last !== "index.html" && !last.includes(".")) {
      const directoryIndex = publishedPathFromSegments([...segments, "index.html"], entryPath);
      if (directoryIndex && directoryIndex !== primary) {
        candidates.push({ path: directoryIndex, fallback: true });
      }
    }
  }

  if (spaFallback && primary !== entryPath) {
    candidates.push({ path: entryPath, fallback: true });
  }

  return candidates;
}

/** Whether the entry document a version serves at its root is HTML. */
export function publishedEntryIsHtml(entryPath: string): boolean {
  const lower = entryPath.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}
