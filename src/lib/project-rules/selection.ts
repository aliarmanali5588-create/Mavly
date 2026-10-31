/**
 * ═══ GLOBAL TEXT-SELECTION STYLING — DETERMINISTIC ══════════════════════════
 *
 * The product requires every generated website to use white selected text on a
 * black background. The prompt asks for it, but a model can forget; this module
 * adds it to the project's existing global stylesheet as a
 * backend post-processing step. It never creates a stylesheet that the project
 * does not already have, and it never rewrites the rest of the file.
 *
 * Pure. The caller persists the returned content.
 */

const STYLESHEET_PRIORITY = [
  "app/globals.css",
  "src/app/globals.css",
  "app/global.css",
  "src/app/global.css",
  "styles/globals.css",
  "src/styles/globals.css",
  "src/index.css",
  "src/App.css",
  "styles.css",
  "src/styles.css",
] as const;

const SELECTION_MARKER = "/* mavly:selection */";

export const SELECTION_RULE_BLOCK = `${SELECTION_MARKER}
::selection {
  background-color: #000000;
  color: #FFFFFF;
}

::-moz-selection {
  background-color: #000000;
  color: #FFFFFF;
}
`;

export interface SelectionRuleResult {
  path: string;
  content: string;
}

/** The project's canonical global stylesheet, or null when it has none. */
export function findGlobalStylesheet(
  files: readonly { path: string; content: string }[],
): { path: string; content: string } | null {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  for (const candidate of STYLESHEET_PRIORITY) {
    const content = byPath.get(candidate);
    if (typeof content === "string") return { path: candidate, content };
  }
  return null;
}

/**
 * True only when the actual selected-text colors are present. The marker alone
 * is not trusted because a later edit may have removed or changed the rule.
 */
export function hasSelectionRule(content: string): boolean {
  const activeCss = content.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = activeCss.match(/::selection\s*\{([^}]*)\}/i)?.[1];
  if (!rule) return false;
  const blackBackground =
    /\bbackground(?:-color)?\s*:\s*#(?:000000|000)\b/i.test(rule);
  const whiteText = /\bcolor\s*:\s*#(?:ffffff|fff)\b/i.test(rule);
  return blackBackground && whiteText;
}

export function withSelectionRule(content: string): string | null {
  if (hasSelectionRule(content)) return null;
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}\n${SELECTION_RULE_BLOCK}`;
}

export function ensureSelectionRule(
  files: readonly { path: string; content: string }[],
): SelectionRuleResult | null {
  const sheet = findGlobalStylesheet(files);
  if (!sheet) return null;
  const updated = withSelectionRule(sheet.content);
  if (updated === null) return null;
  return { path: sheet.path, content: updated };
}
