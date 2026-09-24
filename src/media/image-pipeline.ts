import sharp from 'sharp';

/**
 * Shared WebP variant generation (13-backend-build-plan.md P7 step 6).
 * Framework-agnostic so both the real upload endpoint (P7) and the P3 seed
 * generator (which downloads provider artwork and needs the same
 * thumb/card/full treatment for library-item covers) use one implementation.
 */

export type VariantLabel = 'thumb' | 'card' | 'full';

export interface ImageVariant {
  label: VariantLabel;
  width: number;
  buffer: Buffer;
}

export interface ImagePipelineResult {
  width: number;
  height: number;
  variants: ImageVariant[];
}

const VARIANT_SPECS: { label: VariantLabel; width: number }[] = [
  { label: 'thumb', width: 400 },
  { label: 'card', width: 800 },
  { label: 'full', width: 1600 },
];

/**
 * 26-backend-code-review.md H4: with no explicit budget, only libvips'
 * ~268 MP default `limitInputPixels` applied — a 2 MB PNG at 16000x16000px
 * is 256 MP, under that default, and decodes to roughly 1 GB of RGBA. The
 * old implementation allocated that four times in sequence (one
 * `sharp(original).metadata()` plus three fresh `sharp(original)` decodes,
 * one per variant) on the single pinned Node process (`ecosystem.config.cjs`
 * pins `instances: 1`). 50 MP is generous for any real photograph or cover
 * image while ruling out the pathological case; `MediaService.upload()`
 * catches sharp's own error when this is exceeded and turns it into a typed
 * 422 rather than a 500, so an editor scanning a poster at high DPI is told
 * to downscale instead of taking the process down.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * 30-backend-finishing-prompt.md §2.6: `.clone()` on a `Buffer` input does
 * *not* share a single decode across the three variants below — each
 * `.clone().resize().webp().toBuffer()` call still runs its own libvips
 * decode of `original`. What `.clone()` actually shares is the *options*
 * object passed to the first `sharp(original, { limitInputPixels, pages: 1
 * })` call — `limitInputPixels` in particular, so every cloned pipeline
 * still enforces H4's 50 MP budget without repeating the option at each
 * call site.
 *
 * The real win, and it is a genuine one, is that the loop runs one variant
 * fully to completion (each `toBuffer()` is awaited before the next
 * iteration starts) rather than decoding all three up front — so peak RSS
 * is one decode's worth of pixel buffer, not the old implementation's four
 * simultaneous `sharp(original)` instances. That is exactly what H4 was
 * about; it just isn't a shared-decode optimisation.
 * `toBuffer({ resolveWithObject: true })` is a separate, smaller saving: a
 * variant's real output width comes back alongside its bytes, so reading
 * it never needs a second call on that output just for its metadata.
 */
export async function generateWebpVariants(original: Buffer): Promise<ImagePipelineResult> {
  const img = sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const variants: ImageVariant[] = [];
  for (const spec of VARIANT_SPECS) {
    const { data, info } = await img
      .clone()
      .resize({ width: spec.width, withoutEnlargement: true })
      .webp()
      .toBuffer({ resolveWithObject: true });
    variants.push({ label: spec.label, width: info.width, buffer: data });
  }

  return { width, height, variants };
}
