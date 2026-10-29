/**
 * ═══ IMAGE GENERATION — THE VALUES BOTH HALVES MUST AGREE ON ═════════════════
 *
 * Pure data, no `process.env`, no provider client: the browser imports this to
 * render the form and the server imports it to validate a request. One list
 * means the UI cannot offer a value the server refuses, and the server cannot
 * accept one the UI never shows.
 *
 * ⚠️ THESE ARE THE LOCKED MODEL'S ACCEPTED VALUES, NOT A WISH LIST. They come
 * from OpenRouter's endpoint record for `recraft/recraft-v4.1-flash`
 * (`GET /api/v1/images/models/recraft/recraft-v4.1-flash/endpoints`):
 * `aspect_ratio` is exactly that enum, and the record lists no other
 * generation parameter beyond `n` (1..6). That endpoint accepts several images
 * per call; Mavly deliberately asks for one, because each asset has its own
 * prompt, aspect ratio and durable row. Re-check the record before widening any
 * of these — an unsupported value is a provider 400, not a silent fallback.
 */

export const IMAGE_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "auto"] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg"] as const;

export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

/**
 * The endpoint accepts `n` 1..6; Mavly sends exactly one, because every planned
 * asset is generated, validated, stored and accounted for on its own.
 */
export const IMAGE_MAX_PER_REQUEST = 1;

/** Kept short on purpose: an image prompt is a brief, not a source file. */
export const IMAGE_PROMPT_MAX_LENGTH = 2_000;

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value);
}

export function isImageOutputFormat(value: unknown): value is ImageOutputFormat {
  return typeof value === "string" && (IMAGE_OUTPUT_FORMATS as readonly string[]).includes(value);
}

/** The file extension a downloaded image should carry. */
export function imageExtensionFor(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : "png";
}
