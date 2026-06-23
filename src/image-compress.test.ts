import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { compressImage } from './image-compress.js'

// A real 200x200 red PNG to feed the actual sharp pipeline.
async function redPng(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
}

describe('compressImage', () => {
  it('defaults to WebP @ q80', async () => {
    const out = await compressImage(await redPng())
    expect(out.ext).toBe('webp')
    expect(out.contentType).toBe('image/webp')
    const meta = await sharp(out.data).metadata()
    expect(meta.format).toBe('webp')
  })

  it('downscales when maxWidth is smaller than the source', async () => {
    const out = await compressImage(await redPng(800, 800), { maxWidth: 400 })
    const meta = await sharp(out.data).metadata()
    expect(meta.width).toBe(400)
  })

  it('does not upscale when source is already narrower than maxWidth', async () => {
    const out = await compressImage(await redPng(100, 100), { maxWidth: 400 })
    const meta = await sharp(out.data).metadata()
    expect(meta.width).toBe(100)
  })

  it('honours an explicit format/quality', async () => {
    const out = await compressImage(await redPng(), { format: 'jpeg', quality: 60 })
    expect(out.ext).toBe('jpg')
    expect(out.contentType).toBe('image/jpeg')
    const meta = await sharp(out.data).metadata()
    expect(meta.format).toBe('jpeg')
  })
})
