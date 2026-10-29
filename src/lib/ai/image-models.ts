/**
 * ═══ IMAGE-GENERATION MODEL CATALOG — ONE LOCKED MODEL ═══════════════════════
 *
 * Server-side. Image models live in their OWN catalog, never in `models.ts`:
 * `resolveModel()` picks the model for website/code generation, and an image
 * model selected there would be asked for JSON source files. The two lists do
 * not share an entry, and nothing routes across them.
 *
 * ⚠️ A SLUG IS NOT ENOUGH. Each entry records what the provider's endpoint
 * record actually accepts, because the model is the authority on its own
 * parameters. A request with an unsupported key is a provider 400 — there is no
 * fallback and no "best effort" mapping.
 *
 * `recraft/recraft-v4.1-flash` is the ONLY registered entry and the default.
 * Its parameters were verified against
 * `GET https://openrouter.ai/api/v1/images/models/recraft/recraft-v4.1-flash/endpoints`
 * (Image API, provider `recraft`):
 *
 *   aspect_ratio       1:1, 4:3, 3:4, 16:9, 9:16, auto
 *   n                  1..6 (Mavly always asks for exactly one asset per call)
 *   output_format      NOT supported — do not send it (`meda_type` comes back
 *                      on the response and the bytes are sniffed anyway)
 *   seed               NOT supported — do not send it
 *   resolution         NOT supported — do not send it
 *   quality/background NOT supported — do not send it
 *   stream             NOT supported (`supports_streaming: false`)
 *   pricing            $0.007 per output image (billed per completed image)
 *
 * `input_references` is deliberately not exposed: it would need an existing
 * upload/asset path or a server-side URL fetcher, which is an SSRF surface this
 * integration must not open.
 *
 * ⚠️ THERE IS NO SECOND IMAGE MODEL AND NO FALLBACK. A request naming another
 * slug is refused before any network call; `MAVLY_IMAGE_MODEL` is a selector
 * over this catalog, so an unregistered value resolves to the locked model
 * rather than being forwarded.
 */

import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MAX_PER_REQUEST,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_PROMPT_MAX_LENGTH,
  isImageAspectRatio,
  isImageOutputFormat,
  type ImageAspectRatio,
  type ImageOutputFormat,
} from "@/lib/image-generation-options";

export interface AiImageModel {
  /** OpenRouter model slug, exactly as sent on the wire. */
  id: string;
  label: string;
  aspectRatios: readonly ImageAspectRatio[];
  outputFormats: readonly ImageOutputFormat[];
  defaultAspectRatio: ImageAspectRatio;
  defaultOutputFormat: ImageOutputFormat;
  /**
   * Whether the endpoint record lists `output_format`. When false the field is
   * never sent, and the real format is decided by the returned bytes.
   */
  supportsOutputFormat: boolean;
  /** Images accepted in one request. */
  maxImages: number;
  /** Reference images the endpoint accepts (0 = text-to-image only). */
  maxReferenceImages: number;
  supportsSeed: boolean;
  /**
   * The provider's own price, in USD per completed image. Operator information
   * only — NEVER a Mavly credit price.
   */
  providerUsdPerImage: number | null;
  /**
   * Kept for price-per-megapixel endpoints. `null` when the endpoint bills per
   * image instead.
   */
  providerUsdPerMegapixel: number | null;
}

/** The locked, single image model for this build. */
export const DEFAULT_IMAGE_MODEL_ID = "recraft/recraft-v4.1-flash";

/** Raw USD per completed output image, from the verified endpoint record. */
export const IMAGE_PROVIDER_USD_PER_IMAGE = 0.007;

export const AI_IMAGE_MODEL_CATALOG: readonly AiImageModel[] = [
  {
    id: DEFAULT_IMAGE_MODEL_ID,
    label: "Recraft V4.1 Flash",
    // Exactly the endpoint's enum — not a superset. Defined once in
    // `image-generation-options.ts` and narrowed to this record.
    aspectRatios: IMAGE_ASPECT_RATIOS,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    defaultAspectRatio: "16:9",
    defaultOutputFormat: "png",
    supportsOutputFormat: false,
    maxImages: IMAGE_MAX_PER_REQUEST,
    maxReferenceImages: 0,
    supportsSeed: false,
    providerUsdPerImage: IMAGE_PROVIDER_USD_PER_IMAGE,
    providerUsdPerMegapixel: null,
  },
];

/**
 * The image model id this build uses: `MAVLY_IMAGE_MODEL` when it names a
 * catalog entry, otherwise the locked default.
 *
 * ⚠️ VALIDATED, NOT TRUSTED. The variable is a SELECTOR over
 * `AI_IMAGE_MODEL_CATALOG`, not a way to inject a slug. A value that is not
 * registered here (a typo, a chat-completions model, another provider's slug) is
 * never forwarded to OpenRouter; it resolves to the default, exactly as an unset
 * variable does.
 *
 * ⚠️ IT IS NOT `MAVLY_DEFAULT_MODEL`. That variable selects the website/code
 * generation model in `src/lib/ai/models.ts` and is never read here.
 */
export function configuredImageModelId(): string {
  const override = process.env.MAVLY_IMAGE_MODEL?.trim();
  if (override && AI_IMAGE_MODEL_CATALOG.some((model) => model.id === override)) {
    return override;
  }
  return DEFAULT_IMAGE_MODEL_ID;
}

/** The image model this build uses, resolved in one place. */
export function resolveImageModel(): AiImageModel {
  const id = configuredImageModelId();
  return AI_IMAGE_MODEL_CATALOG.find((model) => model.id === id) ?? AI_IMAGE_MODEL_CATALOG[0];
}

export function imageModelIds(): string[] {
  return AI_IMAGE_MODEL_CATALOG.map((model) => model.id);
}

/** True only for the exact locked slug. Used to refuse a mismatched request. */
export function isLockedImageModel(id: string): boolean {
  return id === DEFAULT_IMAGE_MODEL_ID;
}

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  /**
   * The format Mavly would prefer. It is sent only when the endpoint lists
   * `output_format`; the real format always comes from the returned bytes.
   */
  outputFormat: ImageOutputFormat;
  seed: number | null;
}

export type ImageRequestValidation =
  | { ok: true; request: ImageGenerationRequest }
  | { ok: false; error: string };

/**
 * Validate the body of `POST …/images/generate`.
 *
 * ⚠️ UNSUPPORTED KNOBS ARE REFUSED, NOT IGNORED. A caller that sends
 * `resolution: "4K"` and receives a 1K image was told nothing; answering with
 * the supported set is the only honest option. Unknown keys are ignored so a
 * client can add metadata without a breaking release.
 */
export function parseImageGenerationRequest(
  body: unknown,
  model: AiImageModel,
): ImageRequestValidation {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const rawPrompt = record.prompt;
  const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
  if (!prompt) return { ok: false, error: "Describe the image you want to generate." };
  if (prompt.length > IMAGE_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the image prompt under ${IMAGE_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }

  for (const unsupported of [
    "resolution",
    "quality",
    "background",
    "output_compression",
    "stream",
    "input_references",
    "referenceImages",
    "references",
  ] as const) {
    if (record[unsupported] !== undefined && record[unsupported] !== null) {
      return {
        ok: false,
        error: `This image model does not support \`${unsupported}\`. Supported options: prompt and aspect ratio.`,
      };
    }
  }

  if (record.n !== undefined && record.n !== null && record.n !== IMAGE_MAX_PER_REQUEST) {
    return { ok: false, error: "Mavly requests one image per provider call." };
  }

  const rawAspect = record.aspectRatio ?? record.aspect_ratio;
  let aspectRatio: ImageAspectRatio = model.defaultAspectRatio;
  if (rawAspect !== undefined && rawAspect !== null && rawAspect !== "") {
    if (!isImageAspectRatio(rawAspect) || !model.aspectRatios.includes(rawAspect)) {
      return {
        ok: false,
        error: `Unsupported aspect ratio. Choose one of: ${model.aspectRatios.join(", ")}.`,
      };
    }
    aspectRatio = rawAspect;
  }

  const rawFormat = record.outputFormat ?? record.output_format;
  let outputFormat: ImageOutputFormat = model.defaultOutputFormat;
  if (rawFormat !== undefined && rawFormat !== null && rawFormat !== "") {
    if (!isImageOutputFormat(rawFormat) || !model.outputFormats.includes(rawFormat)) {
      return {
        ok: false,
        error: `Unsupported image format. Choose one of: ${model.outputFormats.join(", ")}.`,
      };
    }
    if (!model.supportsOutputFormat) {
      // The endpoint decides the format; accepting the field and silently
      // ignoring it would misreport what will actually be produced.
      return {
        ok: false,
        error: `This image model chooses its own output format (PNG/JPEG); \`output_format\` is not supported.`,
      };
    }
    outputFormat = rawFormat;
  }

  let seed: number | null = null;
  if (record.seed !== undefined && record.seed !== null) {
    if (!model.supportsSeed) {
      return { ok: false, error: "This image model does not accept a seed." };
    }
    if (
      typeof record.seed !== "number" ||
      !Number.isInteger(record.seed) ||
      record.seed < 0 ||
      record.seed > 2_147_483_647
    ) {
      return { ok: false, error: "A seed must be a whole number between 0 and 2,147,483,647." };
    }
    seed = record.seed;
  }

  return { ok: true, request: { prompt, aspectRatio, outputFormat, seed } };
}

/**
 * The aspect ratios the locked model accepts. The image plan validator imports
 * THIS list, so a plan can never ask for a ratio the provider would reject.
 */
export const IMAGE_PLAN_ASPECT_RATIOS: readonly ImageAspectRatio[] =
  AI_IMAGE_MODEL_CATALOG[0].aspectRatios;
