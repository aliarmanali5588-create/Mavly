import React from "react";

/**
 * ═══ JSON-LD, RENDERED ON THE SERVER ════════════════════════════════════════
 *
 * A plain `<script type="application/ld+json">` in the server-rendered HTML.
 * No `next/script`, no client component, no hydration: structured data must be
 * in the first response a crawler reads, and it must not depend on JavaScript.
 *
 * ⚠️ `<` IS ESCAPED IN THE SERIALISED JSON. `JSON.stringify` leaves `<` alone,
 * so a string containing `</script>` would close the tag early and inject
 * markup. Escaping `<` as `\u003c` is valid JSON and cannot break out of the
 * element. The data here is authored constants, but the renderer is shared and
 * must stay safe if a value ever comes from content.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      // The payload is JSON we built, escaped above. This is the one place
      // dangerouslySetInnerHTML is correct for a script element.
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
