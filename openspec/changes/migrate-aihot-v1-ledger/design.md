## Context

动机见 proposal.md。现状要点：

- `src/fetchers/aihot.ts` 用旧接口：日报 `/api/public/daily/{date}`，精选 `/api/public/items?since&take` + `computeSinceIso(lastSyncedAt)`（`min(lastSyncedAt, now−48h)`，下限 7 天）+ 最近 3 个 PR 的链接键去重 + 触顶时渲染截断提示。
- 已有「fetcher 产物 → frontmatter → 下游读回」先例：`FetchResult.notifyBody` 由 `formatter.ts` 写成 `fm.notify_body`，`summarize-section.ts` 用 `extractNotifyBody` 读回。
- `FetchContext` 只在设置 `TARGET_REPO` 时由 `src/index.ts` 构造；`newestSyncedFirst`（按 title 日期）是「最新已同步 PR」唯一排序规则。
- 已实测 v1（2026-10-09）：
  - `dailies/{date}` 用上海日期，UTC 0 点生成，响应包在 `{schemaVersion, report}` 中，未生成返回 404 problem+json。
  - `items` 不认 `take`/`since`（400），改用 `window=24h|7d`、`limit≤100`、`page.{hasMore,nextCursor}`；cursor 滑出窗口返回 `invalid_cursor`。
  - `selected/snapshot?limit=1` 一页即返回水位 `cursor`，cursor 编码了字段集（`default`/`minimal`）。
  - `selected/changes?cursor=` 返回 `{cursor, hasMore, changes[{op:'upsert'|'remove', changedAt, item|id}]}`；cursor 不按时间过期；无效 cursor 返回 409 `snapshot_required`。
  - permalink 从 `aihot.virxact.com/items/{id}` 变为 `aihot.news/items/{id}`。

## Goals / Non-Goals

**Goals:**
- 10-31 前完成 v1 迁移，切换当天及之后精选「不漏」，重复只允许由已推送集合兜住。
- 状态通道做成通用能力，不针对 aihot 特判，不引入持久化存储。

**Non-Goals:**
- 不维护精选全集的本地镜像（不翻完 snapshot），只用它取水位。
- 不使用 `If-None-Match`/ETag 缓存（每天只调一次，收益为零）。
- 不渲染 `reason`/`score`/`category`；不接入 hot-topics、周报、月报等其它 v1 端点。
- 不调整日报渲染结构（仅改字段映射）。

## Decisions

### D1. 状态放在下游 markdown frontmatter `sync_state`

- `FetchResult.syncState?: Record<string, string>` → `formatter.ts` 在非空时写入 `fm.sync_state`。
- `FetchContext.getLastSyncState?: () => Promise<Record<string, string> | undefined>`：在 `src/pr-listing.ts` 新增读取函数，复用 `fetchRecentSyncedContents(targetRepo, source, 1)`（已按 `newestSyncedFirst` 排序），解析 frontmatter 的 `sync_state`，非字符串值丢弃。解析失败或缺失返回 `undefined`；gh 错误向上抛出，由 fetcher 捕获后走兜底。
- 备选：GitHub Actions cache/artifact（会过期，且违背「问 GitHub PR」）；repo 变量（需要写权限 PAT，对外可见）；PR body/label（label 长度有限，body 需要额外 API）。frontmatter 与 `notify_body` 同构，零新增依赖，回填 PR 天然排在后面。
- 代价：vault 笔记里会多出一行 opaque cursor。可以接受。

### D2. 移除 `lastSyncedAt`

账本模型下没有消费者了。删掉 `FetchContext.lastSyncedAt`、`SyncStatus.lastSyncedAt` 和 `getSyncStatus` 里的计算，只保留 `syncedToday`。兜底窗口固定 `7d`，不再锚定上次同步时间：兜底很少触发，7d 是 API 上限，已推送集合负责去重。备选是保留但闲置，被否决：死代码，而且 CLAUDE.md 里那段说明会误导后来的人。

### D3. 精选控制流

```
getLastSyncState() ─┬─ cursor ──► changes 翻页 ──┬─ 200…   → candidates, syncState=lastAppliedCursor
   (throw → 兜底)    │                            ├─ 5xx/网络 → 已应用部分, syncState=lastApplied ?? C0
                    │                            └─ 409     → 兜底
                    └─ 无 ─────► 兜底: snapshot?limit=1 (先) → items window=7d 翻页 (后)
                                       syncState = snapshotCursor ?? (不写)
                         ▼
               dedup(已推送集合 ∪ 日报键) → render
```

- 页数上限沿用 `MAX_PAGES = 5`、页间隔 200ms。每页 limit=100，单次最多 500 条变更，远高于日均精选量。
- 账本路径的 cursor 只在整页应用后才前移（"Apply a page, then save the returned cursor"）。fetch 成功但 PR 未建成时水位不落盘，下次重读，结果是重复不是遗漏。
- 兜底路径先取 snapshot 再读窗口：两次请求之间入选的条目在窗口里也可能出现，下次账本读取时还会再出现一次，由去重吸收。顺序反过来就会漏。
- changes 里的条目按 `changedAt` 从旧到新排列，渲染时反转成从新到旧，和现在的精选顺序一致。
- 回填（`isDatePinned()`）不调用 `getLastSyncState`，不请求精选，不写 `syncState`。

### D4. 去重键：条目 id + 原文 url

用正则 `https?://(?:aihot\.news|aihot\.virxact\.com)/items/([A-Za-z0-9]+)` 从历史 markdown 和日报 `links.aihot` 里提取 id；从历史 markdown 收集所有链接 url 作为原文键。候选条目的键是 `item.id` 和 `item.links.original`。备选是只比对 permalink 字符串，切换当天新旧域名不一致会全部落空，被否决。

历史读取深度：账本路径 3 个 PR（重叠只来自编辑与切换日）；兜底路径 8 个 PR（7d 窗口约等于 7 个日更 PR，+1 余量）。实现时 smoke 发现兜底窗口一次返回 100+ 条，只读 3 个 PR 会让迁移首日重推 4～7 天前的条目，因此按路径区分深度。

账本路径**仍然需要**已推送集合，原因有三：`upsert` 包含对已入选条目的编辑；兜底切到账本的第一天会有重叠；日报里的条目也会出现在精选里。

### D5. 请求层

- `BASE_URL = 'https://aihot.news/api/v1'`，保留自定义 UA 和「429 退避 1.5s 重试一次」。
- 只把 404 当作业务信号（日报），把 409 当作业务信号（账本）。其它非 2xx 一律视为错误。不解析 problem+json 正文，只在日志里输出 `code`，不输出完整响应体。
- 忽略响应顶层的 `notice`。

## Risks / Trade-offs

- [迁移当天兜底窗口和最后一次旧接口运行之间有重叠] → 已推送集合同时认新旧域名的 id 和原文 url，重叠的条目会被剔除。
- [`sync_state` 写进了一个后来被关闭（CLOSED）的 PR] → 读取只看 OPEN/MERGED，会退回到更早的 PR 或兜底。最坏情况是重复，不会遗漏。
- [cursor 被服务端判定失效] → 409 会被识别并转到兜底，同时重建水位。
- [服务端 `changes` 长时间不可用] → 水位不前移，日报照常发。恢复后一次性补齐，超出 500 条的部分分几天续读。
- [v1 字段将来新增或改名] → 所有字段按可空处理并防御性读取，不在结构上做严格校验。
- [vault 笔记出现 opaque 字段] → 字段名 `sync_state` 一看就是机器状态，Obsidian 里不影响阅读。

## Migration Plan

1. 合入后第一次 cron：最新 PR 没有 `sync_state`，走兜底（7d 窗口 + 去重），写入 snapshot cursor。
2. 第二天 cron：读到 cursor，进入账本路径。查看日志确认走的是 `changes`、候选数量合理、`sync_state` 已更新。
3. 10-31 前至少要观察到一次「兜底 → 账本」的完整切换。
4. 回滚：revert 本 change 即可。10-31 之前旧接口仍然可用；frontmatter 里多出的 `sync_state` 对旧代码无害。
