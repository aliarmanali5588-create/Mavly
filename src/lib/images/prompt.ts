/**
 * ═══ IMAGE PROMPTS — THE ONLY PLACE PLANNING AND CODING LEARN ABOUT ASSETS ═══
 *
 * Three bounded blocks:
 *
 *   · the planner addendum, which asks for the structured `images` plan inside
 *     the existing plan JSON and states the backend ceiling;
 *   · the coding block, which gives the batch the EXACT persisted asset URLs
 *     and forbids inventing, guessing or hotlinking anything else;
 *   · the preview rule, which keeps `preview.html` a self-contained document
 *     (it runs in an opaque-origin sandbox and must not load remote images).
 *
 * ⚠️ NOTHING HERE IS AN INSTRUCTION CHANNEL. These are server-authored strings;
 * the only model-controlled text that ends up in them is a validated prompt,
 * alt text, path and ids, each already bounded by `manifest.ts`.
 */

import type { ImageAssetReference } from "./manifest";
import type { ImagePlanningPolicy } from "./policy";
import { IMAGE_SITE_TYPE_BUDGETS } from "./policy";

/** The planner addendum. Appended to the existing planner system prompt. */
export function plannerImageAddendum(policy: ImagePlanningPolicy): string {
  const guidance = Object.entries(IMAGE_SITE_TYPE_BUDGETS)
    .map(([type, budget]) => `  - ${type}: ${budget.min}-${budget.max} images (${budget.label})`)
    .join("\n");

  return `

Image planning (required for this website):
Also return these two TOP-LEVEL fields in the same JSON object:
  "siteType": "landing" | "saas" | "content" | "local" | "ecommerce" | "catalog" | "other",
  "images": [
    {
      "assetId": "lowercase-id-unique-in-this-plan",
      "pagePath": "/",
      "sectionId": "hero",
      "purpose": "hero" | "product" | "category" | "editorial" | "feature" | "background" | "team" | "testimonial" | "logo" | "other",
      "required": true,
      "priority": 1,
      "prompt": "Specific visual description: subject, composition, lighting, palette, camera/style.",
      "aspectRatio": "16:9",
      "productId": "optional-product-id",
      "productImageIndex": 0,
      "reuseKey": "optional-shared-asset-key",
      "alt": "Short, factual alt text for the rendered placement."
    }
  ]

How many images to plan (choose for THIS website, never a fixed number):
${guidance}
Rules:
- The backend will authorize at most ${policy.maxAssets} NEW image assets for this run and can only reduce that; never propose more, and never treat this number as a target.
- Every image costs the operator real money (about $${policy.usdPerImage.toFixed(3)} each) and the run's image budget is $${policy.maxRunCostUsd.toFixed(2)}. Plan the smallest set that makes the site credible.
- Use aspectRatio only from: 1:1, 4:3, 3:4, 16:9, 9:16, auto.
- "required": true means the page is incomplete without it (a hero, a primary product image). Everything decorative is optional.
- priority: 1 is highest, 5 is lowest. Required assets are considered first regardless.
- Reuse: when two placements should show the SAME picture, give them the same "reuseKey" instead of planning a second image. Never reuse across different products, and never invent a reuseKey for unrelated visuals.
- For an e-commerce store: plan one primary product image per product that needs one, a small number of shared category/collection images, and one store hero. Do not assume several images per product — extra views are optional and must earn their budget.
- For a catalog larger than the budget: plan the essential hero and the highest-priority products first; the backend defers what does not fit, and you must not silently drop products from the file plan because of it.
- Never invent factual product details, brands, prices, certifications or real people. Image prompts should describe illustrative imagery appropriate to the product context, not a fake photograph of real inventory.
- alt must describe the intended image, not repeat the page title.
- preview.html must NOT reference these images or any external URL. The preview is a self-contained sandboxed prototype and uses CSS-only placeholders; the real pages use the assets.
- Titles ("siteType", "images") are the only additions. Do not add any other top-level field, and do not include image bytes or URLs.`;
}

/**
 * The coding prompt block. Only assets that are already persisted are listed:
 * a URL the model was never given must never appear in generated code.
 */
export function batchImageBlock(input: {
  assets: readonly ImageAssetReference[];
  pending: readonly { assetId: string; alt: string; purpose: string; pagePath: string }[];
}): string {
  if (input.assets.length === 0 && input.pending.length === 0) return "";

  const lines: string[] = [
    "Approved image assets (these are the ONLY image URLs you may use):",
  ];

  for (const asset of input.assets.slice(0, 80)) {
    const placement = [
      `page ${asset.pagePath}`,
      asset.sectionId ? `section ${asset.sectionId}` : null,
      `purpose ${asset.purpose}`,
      asset.productId ? `product ${asset.productId}` : null,
      `aspect ${asset.aspectRatio}`,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- ${asset.url} — ${placement} — alt: ${asset.alt}`);
  }

  if (input.assets.length > 0) {
    lines.push(
      "Usage rules:",
      "- Reference these absolute URLs exactly; never invent, shorten, hotlink or guess another image URL.",
      "- Use a plain <img> (or a Next.js <Image> only when next/image is already a dependency) with the given alt text.",
      "- Use the intended image for its page, section and product. Do not swap product images between products.",
      "- Preserve the intended aspect ratio: size the container and use object-fit: cover (object-fit: contain for product cut-outs).",
      "- Add width/height or an aspect-ratio wrapper so the layout does not shift, and loading=\"lazy\" for anything below the fold.",
      "- Keep one consistent visual treatment (radius, shadow, cropping) across all imagery.",
    );
  }

  if (input.pending.length > 0) {
    lines.push(
      "",
      "Assets that are NOT available yet (failed or deferred). Do not fabricate a URL for them:",
    );
    for (const asset of input.pending.slice(0, 40)) {
      lines.push(
        `- ${asset.assetId} on ${asset.pagePath} (${asset.purpose}${asset.alt ? `, alt: ${asset.alt}` : ""}) — render a neutral CSS placeholder block with that alt text and keep the layout slot. Do not claim it is a real photo.`,
      );
    }
  }

  lines.push(
    "",
    "preview.html: NEVER reference these URLs or any remote image — the preview runs in an opaque-origin sandbox and must stay self-contained. Use CSS gradients/shapes as placeholders there.",
  );

  return lines.join("\n");
}

/** The plan summary block the batch prompt shows (counts only, no URLs). */
export function imagePlanBlock(plan: {
  siteType: string;
  approved: number;
  deferred: number;
}): string {
  if (plan.approved === 0 && plan.deferred === 0) return "";
  return [
    `Image plan (${plan.siteType}): ${plan.approved} approved asset(s)` +
      (plan.deferred > 0 ? `, ${plan.deferred} deferred by the run's image budget` : "") +
      ".",
    "Place them exactly where the plan says; when an intended asset is unavailable, keep the layout slot with a placeholder.",
  ].join("\n");
}
