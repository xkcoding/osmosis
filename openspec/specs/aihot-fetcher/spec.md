# Spec: aihot Fetcher

封装 AI HOT REST API（`https://aihot.virxact.com/api/public/*`）的内容抓取，将每日日报与当日精选条目合并为单篇 markdown，并产出 pre-baked notify body 供 IM 卡免摘要直发。

## Requirements

### Requirement: aihot fetcher 类型注册

系统 SHALL 在 fetcher registry 中注册 `aihot` 类型，使用 AI HOT 公开 REST API（`https://aihot.virxact.com/api/public/*`）作为数据源，订阅 yaml 通过 `source.type: aihot` 启用。

#### Scenario: 注册 aihot 类型

- **WHEN** osmosis 启动并加载 `src/fetchers/registry.ts`
- **THEN** registry 中存在 `type === 'aihot'` 的 fetcher，调用 `getFetcher('aihot')` 返回该实现且不抛错

#### Scenario: 通过 yaml 启用

- **WHEN** `subscriptions/aihot.yml` 中 `source.type` 为 `aihot`
- **THEN** 调度层调用对应 fetcher 而不需要在 `src/index.ts` 或 `src/config.ts` 内 special-case 源名

### Requirement: 自定义 User-Agent

aihot fetcher 的所有出站 HTTP 请求 MUST 设置非默认的 `User-Agent` 请求头，格式为 `osmosis/<version> (+https://github.com/xkcoding/osmosis)`。MUST NOT 使用 Node.js 默认 UA 或 `curl/*`。

#### Scenario: UA 注入

- **WHEN** fetcher 调用 `fetch(url)` 访问 `aihot.virxact.com`
- **THEN** 请求头包含 `User-Agent: osmosis/...`，且不以 `curl/` 或 `node/` 开头

### Requirement: 日报作为触发器

fetcher MUST 先调用 `GET /api/public/daily/{today}` 获取今日日报。其中 `{today}` 通过 `todayParts().date` 解析（受 `OSMOSIS_TZ` 控制）。

- 若 HTTP 状态为 404 或响应体含 `error: "No daily report for ..."`，fetcher MUST 返回 `null`，不再调用精选端点。
- 若 HTTP 状态为 2xx，fetcher MUST 继续调用精选端点。
- 其他错误状态（5xx、网络错误）MUST 抛异常，由调度层捕获记录。

#### Scenario: 日报尚未生成

- **WHEN** `GET /api/public/daily/2026-05-08` 返回 404
- **THEN** fetcher 返回 `null`，且 NOT 调用 `/api/public/items`

#### Scenario: 日报已生成

- **WHEN** `GET /api/public/daily/2026-05-08` 返回 200 + 合法 JSON
- **THEN** fetcher 继续调用 `/api/public/items?mode=selected&since={today00:00Z}&take=20`

#### Scenario: 服务端错误

- **WHEN** `GET /api/public/daily/2026-05-08` 返回 500
- **THEN** fetcher 抛异常（消息含状态码与端点路径）

### Requirement: 精选条目获取与降级

日报成功后，fetcher MUST 调用 `GET /api/public/items?mode=selected&since={today_utc_midnight_iso}&take=20`，其中 `{today_utc_midnight_iso}` 是当天 UTC 00:00:00Z 的 ISO 8601 字符串。

- 精选请求失败（任意非 2xx 或网络错误）时 MUST 降级：仍输出仅含日报的 markdown，不抛异常、不返回 null。
- 精选 `items` 数组为空时 MUST 输出仅含日报的 markdown。

#### Scenario: 精选成功

- **WHEN** 精选 API 返回 200 且 `items.length > 0`
- **THEN** 输出 markdown 同时包含「日报段」和「精选池段」

#### Scenario: 精选 API 故障降级

- **WHEN** 精选 API 返回 503 或网络超时
- **THEN** fetcher 输出仅含日报的 markdown 并写日志，不抛异常

#### Scenario: 精选为空

- **WHEN** 精选 API 返回 200 且 `items.length === 0`
- **THEN** 输出 markdown 仅含日报段，不出现空的「精选池」标题

### Requirement: 内容渲染规则

fetcher MUST 将日报 + 精选合并为单篇 markdown，遵循以下结构：

- 顶部为日报 `lead.leadParagraph` 的 blockquote（若 `lead` 为 null，则省略此段）。
- 5 个固定 section（"模型发布/更新" / "产品发布/更新" / "行业动态" / "论文研究" / "技巧与观点"）按 API 返回顺序渲染为二级标题；section.items 为空数组时整段省略。
- `flashes` 数组非空时渲染为「⚡️ 快讯」二级标题列表。
- 精选条目放在「---」分隔后的「🔥 精选池（过去 24 小时）」二级标题列表，每条 `- [{title}]({url}) — {source}`，`summary` 非空时换行缩进展示。
- `title_en` / `summary` / `publishedAt` / `category` / `lead` 为 `null` 时 MUST 妥善降级，不渲染 `null` 字面量。

#### Scenario: lead 为 null

- **WHEN** 日报响应 `lead === null`
- **THEN** 输出 markdown 不包含 blockquote 段，且不出现 `null` 字符串

#### Scenario: 全部 section.items 为空

- **WHEN** 5 个 section 的 `items` 全部为空数组，且 `flashes` 也为空
- **THEN** markdown 中不出现任何空标题；至少 `lead` 段或精选池段保留作为有效内容

#### Scenario: item.summary 为 null

- **WHEN** 精选返回的 item `summary === null`
- **THEN** 该条目仅渲染标题链接 + source 名，不渲染缩进的 summary 行

### Requirement: pre-baked notify body

fetcher MUST 在返回的 `FetchResult` 中填充 `notifyBody` 字段，内容为合并后的 markdown（日报段 + `---` + 精选池段）。当精选为空时 `notifyBody` 仅含日报段。`notifyBody` MUST NOT 超过 20 KB（飞书卡片上限留出余量）；超出时尾部截断并以 `…\n（已截断）` 结尾。

#### Scenario: 含 lead + sections + 精选的标准日

- **WHEN** 日报含 lead 与至少一个非空 section、且精选返回非空 items
- **THEN** `result.notifyBody` 同时含「lead」「日报 section」「精选池」三类标题

#### Scenario: 精选为空时 notifyBody 仅含日报段

- **WHEN** 日报正常返回但精选 items 为空（或精选 API 降级返回 []）
- **THEN** `result.notifyBody` 不含「精选池」标题

#### Scenario: 超长截断

- **WHEN** 渲染后的 notifyBody markdown 超过 20480 字节
- **THEN** 实际字段被截断到 ≤ 20480 字节，且以 `…\n（已截断）` 结尾

### Requirement: FetchResult 不变量

fetcher 输出的 `FetchResult.title` MUST 为 `AI HOT 日报`，`date` MUST 为今日 `YYYY-MM-DD`（与 `todayParts().date` 一致），`sourceUrl` MUST 为 `https://aihot.virxact.com/`。

#### Scenario: 标准成功路径

- **WHEN** 日报与精选均正常返回
- **THEN** `result.title === 'AI HOT 日报'`、`result.date` 与 `todayParts().date` 相等、`result.sourceUrl === 'https://aihot.virxact.com/'`
