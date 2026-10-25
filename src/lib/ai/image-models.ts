/**
 * ═══ IMAGE-GENERATION MODEL CATALOG ══════════════════════════════════════════
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
 * `black-forest-labs/flux.2-klein-4b` is the DEFAULT and the only registered
 * entry today; `MAVLY_IMAGE_MODEL` may select another entry once one is added
 * here (see `resolveImageModel`). Its parameters were verified against
 * `GET https://openrouter.ai/api/v1/images/models/black-forest-labs/flux.2-klein-4b/endpoints`:
 *
 *   aspect_ratio      1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16, 21:9, auto
 *   output_format     png, jpeg
 *   n                 1 (exactly; no multi-image)
 *   input_references  0..4 (image-to-image)
 *   seed              supported
 *   resolution        NOT supported — do not send it
 *   pricing           $0.014 per megapixel of output image
 *
 * `input_references` is deliberately not exposed yet: it would need an existing
 * upload/asset path (uploads are unimplemented here) or a server-side URL
 * fetcher, which is an SSRF surface this integration must not open.
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
  /** Images accepted in one request. */
  maxImages: number;
  /** Reference images the endpoint accepts (0 = text-to-image only). */
  maxReferenceImages: number;
  supportsSeed: boolean;
  /**
   * The provider's own price, in USD per output megapixel. Operator
   * information only — NEVER a Mavly credit price. There is no credit engine in
   * this build and this field must not be used to invent one.
   */
  providerUsdPerMegapixel: number | null;
}

/**
 * Used whenever `MAVLY_IMAGE_MODEL` is unset or does not name a catalog entry.
 * Changing it changes the fallback for every deployment that has not set the
 * variable.
 */
export const DEFAULT_IMAGE_MODEL_ID = "black-forest-labs/flux.2-klein-4b";

export const AI_IMAGE_MODEL_CATALOG: readonly AiImageModel[] = [
  {
    id: DEFAULT_IMAGE_MODEL_ID,
    label: "FLUX.2 Klein 4B",
    aspectRatios: IMAGE_ASPECT_RATIOS,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    defaultAspectRatio: "1:1",
    defaultOutputFormat: "png",
    maxImages: IMAGE_MAX_PER_REQUEST,
    maxReferenceImages: 4,
    supportsSeed: true,
    providerUsdPerMegapixel: 0.014,
  },
];

/**
 * The image model id this build uses: `MAVLY_IMAGE_MODEL` when it names a
 * catalog entry, otherwise the built-in default.
 *
 * ⚠️ VALIDATED, NOT TRUSTED. The variable is a SELECTOR over
 * `AI_IMAGE_MODEL_CATALOG`, not a way to inject a slug. A value that is not
 * registered here (a typo, a chat-completions model, another provider's slug) is
 * never forwarded to OpenRouter; it resolves to the default, exactly as an unset
 * variable does. Validation is also what keeps the route honest: every
 * capability it enforces — aspect ratios, output formats, `n`, seed support,
 * price — comes from the catalog entry, so a model with no entry would be sent
 * options nobody verified against its endpoint record.
 *
 * ⚠️ IT IS NOT `MAVLY_DEFAULT_MODEL`. That variable selects the website/code
 * generation model in `src/lib/ai/models.ts` and is never read here. The two
 * catalogs share no entry, so neither variable can select the other's model.
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

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio: ImageAspectRatio;
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
  ] as const) {
    if (record[unsupported] !== undefined) {
      return {
        ok: false,
        error: `This image model does not support \`${unsupported}\`. Supported options: aspect ratio, format and seed.`,
      };
    }
  }

  const references = record.input_references ?? record.referenceImages ?? record.references;
  if (references !== undefined && references !== null) {
    return {
      ok: false,
      error: "Reference images are not supported yet. Describe the image in the prompt instead.",
    };
  }

  if (record.n !== undefined && record.n !== null && record.n !== IMAGE_MAX_PER_REQUEST) {
    return {
      ok: false,
      error: "This image model generates one image per request.",
    };
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
