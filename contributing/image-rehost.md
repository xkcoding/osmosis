# Image Rehosting

Some sources (e.g. 橘鸦 AI 早报) inline images from a third-party host whose URLs
expire. To keep digests readable long after publication, osmosis can download
each image, compress it, upload it to **your own Aliyun OSS**, and rewrite the
markdown to point at your CDN domain — all at fetch time, before the file is
written to the vault.

This is opt-in per subscription and a no-op when OSS env vars are absent (local
runs, missing secrets), so nothing breaks when it's not configured.

## Enable it on a subscription

Add an `images:` block to `subscriptions/<slug>.yml`:

```yaml
images:
  rehost: true        # turn it on
  format: webp        # webp (default) | jpeg | png
  quality: 80         # 0-100, default 80
  maxWidth: 1600      # optional; downscale wider images. Omit = no resize.
  # keyPrefix: foo    # optional; OSS key sub-path. Default = subscription slug.
  # skipHosts:        # optional; extra hostnames to leave untouched.
  #   - example.com
```

GIFs are preserved as **animated** WebP (smaller, still plays in Obsidian's
Chromium renderer) — do not flip sharp's `animated` flag off.

## Configure OSS (env vars / secrets)

Credentials never live in yaml. The fetch step reads them from the environment:

| Var | Required | Notes |
|---|---|---|
| `OSS_ACCESS_KEY_ID` | ✅ | secret |
| `OSS_ACCESS_KEY_SECRET` | ✅ | secret |
| `OSS_BUCKET` | ✅ | bucket name |
| `OSS_REGION` | one of region/endpoint | e.g. `oss-cn-hangzhou` |
| `OSS_ENDPOINT` | one of region/endpoint | overrides region if both set |
| `OSS_CDN_BASE_URL` | optional | public base, e.g. `https://cdn.you.com`. Falls back to the raw OSS object URL. |
| `OSS_KEY_PREFIX` | optional | top-level namespace, default `osmosis` |
| `OSS_PROCESS_STYLE` | optional | OSS image style appended to stored URLs as `?x-oss-process=style/<name>` |

Objects are organised under a fixed namespace by **source + date**:

```
<OSS_KEY_PREFIX>/<keyPrefix|slug>/<date>/<sha256[:16]>.<ext>
# e.g. osmosis/juya-ai-daily/2026-06-23/abcd…ef.webp
```

The filename is content-addressed, so the same image **dedups within a day** and
re-runs skip the upload (existing object detected via `HEAD`). Because the date
is in the path, an identical image on two different days is stored twice — a
deliberate trade of cross-day dedup for date-based browsability (daily reports
rarely repeat images).

The stored URL is assembled as:

```
<OSS_CDN_BASE_URL>/<key>?x-oss-process=style/<OSS_PROCESS_STYLE>
# e.g. https://cdn.xkcoding.com/osmosis/juya-ai-daily/2026-06-23/abcd…ef.webp?x-oss-process=style/tag_compress
```

**Compression is done by sharp before upload** (default WebP q80). The
`?x-oss-process=style/...` suffix is a separate CDN delivery-style convention
(tag/watermark/etc.) — it is *not* the compression step. Leave `OSS_PROCESS_STYLE`
unset if you don't use an OSS style.

In GitHub Actions, set the non-secret values as **repository variables** and the
two keys as **secrets**; they're already wired into the `Fetch subscription`
step of `.github/workflows/daily-sync.yml`.

## How it fits the pipeline

`runFetch` calls rehosting **after the quality gate passes, before writing** —
so OSS work only happens for content that will actually land in the vault, and
the summarizer later reads the already-rehosted URLs from the PR.

A single image that fails (404, decode error, OSS hiccup) **keeps its original
URL** and is logged; it never fails the whole fetch.

## Code layout

| File | Responsibility |
|---|---|
| `src/oss.ts` | `ali-oss` client from env + `ossPutObject` (with HEAD-dedup) |
| `src/image-compress.ts` | `sharp` wrapper — re-encode (default WebP q80), optional resize |
| `src/image-rehost.ts` | pure `rehostImages` (DI core) + `rehostMarkdownImages` (real wiring) |

The core is dependency-injected, so `src/image-rehost.test.ts` exercises URL
extraction, dedup, skip rules, and the keep-original-on-failure invariant
without touching sharp, OSS, or the network.
