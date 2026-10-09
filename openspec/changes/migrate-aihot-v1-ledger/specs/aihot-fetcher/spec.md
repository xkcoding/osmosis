## MODIFIED Requirements

### Requirement: aihot fetcher 类型注册

系统 SHALL 在 fetcher registry 中注册 `aihot` 类型，使用 AI HOT v1 公开 REST API（`https://aihot.news/api/v1/*`）作为数据源，订阅 yaml 通过 `source.type: aihot` 启用。fetcher MUST NOT 访问旧域名 `aihot.virxact.com` 或旧接口 `/api/public/*`。

#### Scenario: 注册 aihot 类型

- **WHEN** osmosis 启动并加载 `src/fetchers/registry.ts`
- **THEN** registry 中存在 `type === 'aihot'` 的 fetcher，调用 `getFetcher('aihot')` 返回该实现且不抛错

#### Scenario: 通过 yaml 启用

- **WHEN** `subscriptions/aihot.yml` 中 `source.type` 为 `aihot`
- **THEN** 调度层调用对应 fetcher 而不需要在 `src/index.ts` 或 `src/config.ts` 内 special-case 源名

#### Scenario: 只访问 v1

- **WHEN** fetcher 完成一次完整抓取（任一路径）
- **THEN** 所有出站请求 URL 均以 `https://aihot.news/api/v1/` 开头

### Requirement: 自定义 User-Agent

aihot fetcher 的所有出站 HTTP 请求 MUST 设置非默认的 `User-Agent` 请求头，格式为 `osmosis/<version> (+https://github.com/xkcoding/osmosis)`。MUST NOT 使用 Node.js 默认 UA 或 `curl/*`。收到 HTTP 429 时 MUST 退避后重试一次。

#### Scenario: UA 注入

- **WHEN** fetcher 调用 `fetch(url)` 访问 `aihot.news`
- **THEN** 请求头包含 `User-Agent: osmosis/...`，且不以 `curl/` 或 `node/` 开头

#### Scenario: 429 重试一次

- **WHEN** 某请求首次返回 429、重试返回 200
- **THEN** fetcher 使用重试结果继续，不抛异常

### Requirement: 日报作为触发器

fetcher MUST 先调用 `GET /api/v1/dailies/{today}` 获取今日日报，`{today}` 通过 `todayParts().date` 解析（上海日历日期，受 `OSMOSIS_TZ` 控制）。日报内容取自响应的 `report` 对象。

- 若 HTTP 状态为 404，fetcher MUST 返回 `null`，不再调用任何精选端点。
- 若 HTTP 状态为 2xx，fetcher MUST 继续获取精选。
- 其他错误状态（5xx、网络错误）MUST 抛异常，由调度层捕获记录。

#### Scenario: 日报尚未生成

- **WHEN** `GET /api/v1/dailies/2026-10-20` 返回 404（`application/problem+json`）
- **THEN** fetcher 返回 `null`，且 NOT 调用 `/api/v1/selected/*` 或 `/api/v1/items`

#### Scenario: 日报已生成

- **WHEN** `GET /api/v1/dailies/2026-10-20` 返回 200 + `{ schemaVersion: 1, report: {...} }`
- **THEN** fetcher 渲染 `report` 并继续获取精选

#### Scenario: 服务端错误

- **WHEN** `GET /api/v1/dailies/2026-10-20` 返回 500
- **THEN** fetcher 抛异常（消息含状态码与端点路径）

### Requirement: 精选条目获取与降级

日报成功且非回填运行时，fetcher MUST 获取「自上一次同步以来新入选」的精选条目：存在可用的上一次同步 cursor 时走账本路径（见「精选账本增量」），否则走兜底路径（见「精选兜底窗口」）。回填运行（`OSMOSIS_DATE` 固定日期）MUST NOT 获取精选，只输出日报。

- 精选获取失败（非 2xx 或网络错误）时 MUST 降级：仍输出含日报的 markdown，不抛异常、不返回 null。
- 去重后无精选条目时 MUST 输出仅含日报的 markdown。

#### Scenario: 精选成功

- **WHEN** 精选获取返回至少一条未推送过的新入选条目
- **THEN** 输出 markdown 同时包含「日报段」和「精选段」

#### Scenario: 精选 API 故障降级

- **WHEN** 精选端点返回 503 或网络超时
- **THEN** fetcher 输出含日报的 markdown 并写日志，不抛异常

#### Scenario: 精选为空

- **WHEN** 精选获取成功但去重后无条目
- **THEN** 输出 markdown 仅含日报段，不出现空的精选标题

#### Scenario: 回填运行

- **WHEN** 设置 `OSMOSIS_DATE` 为历史日期运行
- **THEN** fetcher 只请求日报端点，输出仅含该日日报

### Requirement: 内容渲染规则

fetcher MUST 将日报 + 精选合并为单篇 markdown，遵循以下结构：

- 顶部为日报 `lead.leadParagraph` 的 blockquote（若 `lead` 为 null，则省略此段）。
- 日报 section 按 API 返回顺序渲染为二级标题（已知 label 加 emoji 前缀）；section.items 为空数组时整段省略。
- `flashes` 数组非空时渲染为「⚡️ 快讯」二级标题列表。
- 精选条目放在「---」分隔后的「🔥 新入选精选」二级标题列表。
- 每条链接行为 `- [{title}]({links.aihot}) — {source.name}（[原文]({links.original})）`；缺少站内链接时退化为 `- [{title}]({links.original}) — {source.name}`；`summary` 非空时换行缩进展示。
- MUST NOT 渲染 `reason`、`score`、`category` 等元数据字段。
- 可空字段为 `null` 时 MUST 妥善降级，不渲染 `null` 字面量。

#### Scenario: lead 为 null

- **WHEN** 日报 `report.lead === null`
- **THEN** 输出 markdown 不包含 blockquote 段，且不出现 `null` 字符串

#### Scenario: 全部 section.items 为空

- **WHEN** 所有 section 的 `items` 为空数组，且 `flashes` 也为空
- **THEN** markdown 中不出现任何空标题

#### Scenario: item.summary 为 null

- **WHEN** 精选条目 `summary === null`
- **THEN** 该条目仅渲染标题链接 + 来源名，不渲染缩进的 summary 行

#### Scenario: 不渲染推荐理由

- **WHEN** 精选条目带非空 `reason`
- **THEN** 输出 markdown 不包含该 `reason` 文本

### Requirement: FetchResult 不变量

fetcher 输出的 `FetchResult.title` MUST 为 `AI HOT 日报`，`date` MUST 为今日 `YYYY-MM-DD`（与 `todayParts().date` 一致），`sourceUrl` MUST 为 `https://aihot.news/`。

#### Scenario: 标准成功路径

- **WHEN** 日报与精选均正常返回
- **THEN** `result.title === 'AI HOT 日报'`、`result.date` 与 `todayParts().date` 相等、`result.sourceUrl === 'https://aihot.news/'`

## ADDED Requirements

### Requirement: 精选账本增量

当上一次同步状态含 `cursor` 时，fetcher MUST 以该 cursor 调用 `GET /api/v1/selected/changes`（默认字段集）并按返回的 `cursor` 逐页续读，直到 `hasMore === false` 或达到页数上限。

- `upsert` 变更中 `item.selected !== false` 的条目 MUST 作为候选；同一批次中后续出现 `remove` 的条目 MUST 从候选中剔除；对本批次之外条目的 `remove` MUST 忽略。
- 同一条目在批次内多次 `upsert` 时 MUST 只保留一条（以最后一次为准）。
- 结果 MUST 携带同步状态 `cursor` = 最后一个**成功应用**页返回的 cursor。
- 达到页数上限且 `hasMore` 仍为 true 时，MUST 写入最后已应用页的 cursor 以便下次续读，且 MUST NOT 在内容中渲染截断提示。
- 翻页中途请求失败（非 409）时，MUST 保留已应用页的条目，并携带最后已应用页的 cursor（首页即失败则携带原 cursor 不变），不得前移水位。
- 返回 `409` 时 MUST 改走「精选兜底窗口」。

#### Scenario: 增量读取

- **WHEN** 上次状态 cursor 为 `C0`，`changes?cursor=C0` 返回 2 个 upsert、`hasMore: false`、`cursor: C1`
- **THEN** 2 条进入候选，结果同步状态 `cursor === 'C1'`

#### Scenario: 同批 remove 剔除

- **WHEN** 同一批次先 upsert 条目 X、后 remove 条目 X
- **THEN** X 不出现在输出中

#### Scenario: 触顶续读

- **WHEN** 达到页数上限时最后一页返回 `hasMore: true, cursor: Cn`
- **THEN** 结果同步状态 `cursor === 'Cn'`，内容不含截断提示

#### Scenario: 首页瞬时失败

- **WHEN** `changes?cursor=C0` 返回 503
- **THEN** 输出仅含日报，结果同步状态 `cursor === 'C0'`

#### Scenario: cursor 失效

- **WHEN** `changes?cursor=C0` 返回 409 `snapshot_required`
- **THEN** fetcher 走兜底窗口路径并写入新的 snapshot cursor

### Requirement: 精选兜底窗口

当无可用 cursor（上次状态缺失、读取失败或账本返回 409）时，fetcher MUST：

1. **先** 调用 `GET /api/v1/selected/snapshot?limit=1`（默认字段集）取得新水位 cursor；
2. **再** 调用 `GET /api/v1/items?mode=selected&window=7d&by=timeline&limit=100` 按 `nextCursor` 翻页，直到 `hasMore === false`、出现无新 id 的页或达到页数上限；
3. 结果携带同步状态 `cursor` = 第 1 步取得的 cursor。

水位先于窗口读取，保证两者之间入选的条目在下次账本读取中出现（宁重勿漏，由已推送集合去重）。snapshot 请求失败时 MUST 仍输出窗口结果，且结果 MUST NOT 携带同步状态（下次继续兜底）。达到页数上限且仍有更多时，MUST 在精选段末尾渲染可见的截断提示。

#### Scenario: 首次迁移

- **WHEN** 最新已同步 PR 无 `sync_state`
- **THEN** fetcher 先请求 snapshot 再请求 items 窗口，结果同步状态 `cursor` 为 snapshot 返回值

#### Scenario: snapshot 失败

- **WHEN** snapshot 返回 503，items 窗口返回正常
- **THEN** 输出含窗口精选，结果不携带同步状态

#### Scenario: 兜底触顶

- **WHEN** items 窗口翻到页数上限仍 `hasMore: true`
- **THEN** 精选段末尾含可见截断提示

### Requirement: 已推送集合去重

无论走账本还是兜底路径，fetcher MUST 在渲染前剔除已推送过或与当日日报重复的精选条目。已推送集合取自本源最近已同步 PR 的 markdown：账本路径取最近 3 个；兜底窗口路径取最近 8 个（覆盖 7 天窗口，避免首次迁移重推更早已推送的条目）。比对键为：

- 条目 id：从任一 `https://aihot.news/items/{id}` 或 `https://aihot.virxact.com/items/{id}` 链接中提取（新旧域名视为同一条目）；
- 原文 url。

任一键命中即视为重复。已推送集合读取失败时 MUST 降级为空集合继续（宁重勿漏）。

#### Scenario: 旧域名历史去重

- **WHEN** 历史 PR 含链接 `https://aihot.virxact.com/items/abc`，本次精选含 id 为 `abc` 的条目（站内链接为 `https://aihot.news/items/abc`）
- **THEN** 该条目被剔除

#### Scenario: 原文 url 命中

- **WHEN** 精选条目的 `links.original` 出现在当日日报中
- **THEN** 该条目被剔除

#### Scenario: 已编辑条目不重推

- **WHEN** 账本返回对一个已推送条目的 upsert（编辑）
- **THEN** 该条目被剔除

#### Scenario: 兜底路径覆盖整个窗口的历史

- **WHEN** 走兜底窗口路径，且 6 天前已推送的条目仍在 7d 窗口内
- **THEN** fetcher 读取最近 8 个已同步 PR 构建已推送集合，该条目被剔除

#### Scenario: 已推送集合读取失败

- **WHEN** 读取历史 PR 内容抛错
- **THEN** fetcher 以空集合继续，仍输出精选
