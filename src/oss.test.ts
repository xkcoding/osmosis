import { describe, it, expect } from 'vitest'
import { buildPublicUrl, type OssConfig } from './oss.js'

const base: OssConfig = {
  accessKeyId: 'k',
  accessKeySecret: 's',
  bucket: 'b',
  region: 'oss-cn-hangzhou',
  keyPrefix: 'osmosis',
}

const KEY = 'osmosis/juya-ai-daily/2026-06-23/abcdef0123456789.webp'
const OBJ_URL = 'https://b.oss-cn-hangzhou.aliyuncs.com/' + KEY

describe('buildPublicUrl', () => {
  it('uses the CDN base when set', () => {
    const url = buildPublicUrl({ ...base, cdnBaseUrl: 'https://cdn.xkcoding.com' }, KEY, OBJ_URL)
    expect(url).toBe(`https://cdn.xkcoding.com/${KEY}`)
  })

  it('falls back to the OSS object URL when no CDN base', () => {
    expect(buildPublicUrl(base, KEY, OBJ_URL)).toBe(OBJ_URL)
  })

  it('appends the process-style suffix (CDN convention, not compression)', () => {
    const url = buildPublicUrl(
      { ...base, cdnBaseUrl: 'https://cdn.xkcoding.com', processStyle: 'tag_compress' },
      KEY,
      OBJ_URL,
    )
    expect(url).toBe(`https://cdn.xkcoding.com/${KEY}?x-oss-process=style/tag_compress`)
  })

  it('appends the style suffix on the OSS object URL too', () => {
    const url = buildPublicUrl({ ...base, processStyle: 'tag_compress' }, KEY, OBJ_URL)
    expect(url).toBe(`${OBJ_URL}?x-oss-process=style/tag_compress`)
  })
})
