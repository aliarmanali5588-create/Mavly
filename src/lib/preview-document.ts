/**
 * ═══ A PREVIEW MAY BE SHORT — IT MAY NOT BE HALF A DOCUMENT ═════════════════
 *
 * `preview.html` is the one generated file a user sees immediately, so a
 * provider that stops at its output limit can turn a success into a blank frame.
 * The provider contract already reports `finish_reason: "length"` as a failure,
 * but a response can also parse as valid JSON while one file's content is cut
 * mid-tag. This module is the second wall: it checks the DOCUMENT, not just the
 * JSON envelope, before any batch is handed to the caller for persistence.
 *
 * The checks are deliberately structural and cheap. They are not an HTML
 * validator — they answer one question: "could a browser render this as a
 * complete standalone document, or is it visibly truncated?"
 *
 * This module is pure and dependency-free so it can be used by the agent and
 * tested with plain string fixtures.
 */

/** The file whose structure is verified. Generated previews are always root-level. */
export const PREVIEW_ENTRY_PATH = "preview.html";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Strip what a browser ignores before the document element: a BOM, leading
 * whitespace and HTML comments. A leading comment is legal HTML, so refusing it
 * would reject a complete document for the wrong reason.
 */
function documentHead(text: string): string {
  let head = text.replace(/^\uFEFF/, "").trimStart();
  for (;;) {
    if (!head.startsWith("<!--")) return head;
    const end = head.indexOf("-->", 4);
    if (end === -1) return head;
    head = head.slice(end + 3).trimStart();
  }
}

/**
 * Return a short, user-safe reason when `content` is not a complete standalone
 * HTML document, or `null` when it is structurally usable.
 *
 * ⚠️ THE RETURN VALUE IS SHOWN TO A USER. It names the missing structure only;
 * it never echoes model output or a provider payload.
 */
export function previewDocumentProblem(content: string): string | null {
  const text = content.trim();
  if (!text) return "the preview was empty";

  const head = documentHead(text).toLowerCase();
  if (!head.startsWith("<!doctype html") && !head.startsWith("<html")) {
    return "the preview did not start with an HTML document";
  }

  const lower = text.toLowerCase();
  if (!lower.includes("<html")) return "the preview has no <html> element";
  if (!lower.includes("</html>")) return "the preview was cut off before </html>";
  if (!lower.includes("<body")) return "the preview has no <body> element";

  const lastCharacter = text.slice(-1);
  if (lastCharacter !== ">") return "the preview ended in the middle of a tag";

  const scriptOpen = countOccurrences(lower, "<script");
  const scriptClose = countOccurrences(lower, "</script>");
  if (scriptOpen !== scriptClose) return "the preview has an unclosed <script> element";

  const styleOpen = countOccurrences(lower, "<style");
  const styleClose = countOccurrences(lower, "</style>");
  if (styleOpen !== styleClose) return "the preview has an unclosed <style> element";

  return null;
}
