import sharp from 'sharp'

export type ImageFormat = 'webp' | 'jpeg' | 'png'

export interface CompressOptions {
  /** Output format. Default "webp" (mirrors baoyu-compress-image). */
  format?: ImageFormat
  /** Encoder quality 0-100. Default 80. */
  quality?: number
  /** Optional max width in px; larger images are scaled down (never up). Off by default. */
  maxWidth?: number
}

export interface CompressedImage {
  data: Buffer
  ext: string
  contentType: string
}

const FORMAT_META: Record<ImageFormat, { ext: string; contentType: string }> = {
  webp: { ext: 'webp', contentType: 'image/webp' },
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  png: { ext: 'png', contentType: 'image/png' },
}

/**
 * Re-encode an image buffer with sharp. Defaults to WebP @ quality 80, matching
 * the baoyu-compress-image conventions. Optional `maxWidth` downscales oversized images.
 *
 * NOTE: animated inputs (GIF) are flattened to their FIRST FRAME — we do NOT emit
 * animated WebP. Reason: the target CDN serves images only through an OSS image
 * style, which (a) rejects animated WebP with `BadWebPImage` and (b) flattens any
 * animation to a static frame anyway. So a static first-frame keeps the URL working
 * instead of 400-ing. (Verified against the live bucket, 2026-06-23.)
 */
export async function compressImage(data: Buffer, opts: CompressOptions = {}): Promise<CompressedImage> {
  const format = opts.format ?? 'webp'
  const quality = opts.quality ?? 80

  // First frame only — do NOT pass { animated: true } (see note above).
  let pipeline = sharp(data)

  if (opts.maxWidth) {
    const meta = await pipeline.metadata()
    if (meta.width && meta.width > opts.maxWidth) {
      pipeline = pipeline.resize({ width: opts.maxWidth, withoutEnlargement: true })
    }
  }

  if (format === 'webp') pipeline = pipeline.webp({ quality })
  else if (format === 'jpeg') pipeline = pipeline.jpeg({ quality })
  else pipeline = pipeline.png({ quality })

  const out = await pipeline.toBuffer()
  const meta = FORMAT_META[format]
  return { data: out, ext: meta.ext, contentType: meta.contentType }
}
