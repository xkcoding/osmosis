import OSS from 'ali-oss'

export interface OssConfig {
  region?: string
  endpoint?: string
  accessKeyId: string
  accessKeySecret: string
  bucket: string
  /** Public base URL (CDN domain) used to build the stored link. Falls back to OSS object URL. */
  cdnBaseUrl?: string
  /** Top-level key namespace. Default "osmosis"; keys are <keyPrefix>/<slug>/<date>/<hash>.<ext>. */
  keyPrefix: string
  /**
   * OSS image style name appended as `?x-oss-process=style/<name>` to stored URLs.
   * This is a CDN delivery-style convention (tag/watermark/etc.), NOT the
   * compression step — compression happens with sharp before upload.
   */
  processStyle?: string
}

/** Build the public URL for a stored object: CDN base when set, else the OSS object URL, plus the style suffix. */
export function buildPublicUrl(config: OssConfig, key: string, objectUrl: string): string {
  const base = config.cdnBaseUrl ? `${config.cdnBaseUrl}/${key}` : objectUrl
  return config.processStyle ? `${base}?x-oss-process=style/${config.processStyle}` : base
}

/**
 * Build an OSS client + resolved config from environment variables.
 * Returns null when the mandatory credentials/bucket are not configured, so the
 * pipeline can degrade gracefully (local runs, missing secrets) instead of failing.
 */
export function ossClientFromEnv(): { client: OSS; config: OssConfig } | null {
  // GitHub Actions passes unset `vars.X` / `secrets.X` as EMPTY STRINGS, not unset.
  // Treat blank as absent so `?? default` works and the OSS_KEY_PREFIX namespace
  // is never silently dropped (a dropped prefix lands keys outside the RAM policy).
  const env = (key: string): string | undefined => {
    const v = process.env[key]
    return v && v.trim() ? v.trim() : undefined
  }

  const accessKeyId = env('OSS_ACCESS_KEY_ID')
  const accessKeySecret = env('OSS_ACCESS_KEY_SECRET')
  const bucket = env('OSS_BUCKET')
  const region = env('OSS_REGION')
  const endpoint = env('OSS_ENDPOINT')

  if (!accessKeyId || !accessKeySecret || !bucket || (!region && !endpoint)) {
    return null
  }

  const config: OssConfig = {
    region,
    endpoint,
    accessKeyId,
    accessKeySecret,
    bucket,
    cdnBaseUrl: env('OSS_CDN_BASE_URL')?.replace(/\/+$/, ''),
    keyPrefix: (env('OSS_KEY_PREFIX') ?? 'osmosis').replace(/^\/+|\/+$/g, ''),
    processStyle: env('OSS_PROCESS_STYLE'),
  }

  const client = new OSS({
    region: config.region,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    secure: true,
  })

  return { client, config }
}

/** True when an object already exists at `key` (so we can skip re-uploading identical bytes). */
async function objectExists(client: OSS, key: string): Promise<boolean> {
  try {
    await client.head(key)
    return true
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 404) return false
    throw err
  }
}

/**
 * Upload `data` to OSS under `key` (content-addressed by the caller). Skips the
 * PUT when an object already exists at the key. Returns the public URL —
 * CDN-based when `cdnBaseUrl` is set, otherwise the OSS object URL.
 */
export async function ossPutObject(
  client: OSS,
  config: OssConfig,
  key: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  if (!(await objectExists(client, key))) {
    await client.put(key, data, { mime: contentType })
  }
  return buildPublicUrl(config, key, client.generateObjectUrl(key))
}
