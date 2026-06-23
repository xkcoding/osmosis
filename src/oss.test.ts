import { describe, it, expect, afterEach } from 'vitest'
import { buildPublicUrl, ossClientFromEnv, type OssConfig } from './oss.js'

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

describe('ossClientFromEnv', () => {
  const ENV_KEYS = [
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET',
    'OSS_BUCKET',
    'OSS_REGION',
    'OSS_ENDPOINT',
    'OSS_CDN_BASE_URL',
    'OSS_KEY_PREFIX',
    'OSS_PROCESS_STYLE',
  ]
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  function setEnv(over: Record<string, string>): void {
    for (const k of ENV_KEYS) delete process.env[k]
    Object.assign(process.env, over)
  }

  it('returns null when credentials are missing', () => {
    setEnv({})
    expect(ossClientFromEnv()).toBeNull()
  })

  it('treats empty-string vars (GitHub Actions unset) as absent → keyPrefix defaults to osmosis', () => {
    setEnv({
      OSS_ACCESS_KEY_ID: 'k',
      OSS_ACCESS_KEY_SECRET: 's',
      OSS_BUCKET: 'xkcoding-blog',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_ENDPOINT: '', // unset GH var arrives as ''
      OSS_KEY_PREFIX: '', // <- the bug: '' must NOT survive as the prefix
      OSS_CDN_BASE_URL: '',
      OSS_PROCESS_STYLE: '',
    })
    const res = ossClientFromEnv()
    expect(res).not.toBeNull()
    expect(res!.config.keyPrefix).toBe('osmosis')
    expect(res!.config.endpoint).toBeUndefined()
    expect(res!.config.cdnBaseUrl).toBeUndefined()
    expect(res!.config.processStyle).toBeUndefined()
  })

  it('honours an explicit OSS_KEY_PREFIX', () => {
    setEnv({
      OSS_ACCESS_KEY_ID: 'k',
      OSS_ACCESS_KEY_SECRET: 's',
      OSS_BUCKET: 'xkcoding-blog',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_KEY_PREFIX: 'custom',
    })
    expect(ossClientFromEnv()!.config.keyPrefix).toBe('custom')
  })
})
