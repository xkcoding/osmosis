## Why

AI HOT 已发布停服通知：旧接口 `/api/public/*` 与旧域名 `aihot.virxact.com` 于 **2026-10-31** 停止服务（旧域名此后只 301 跳到 `aihot.news` 同路径，而该路径同样停服），之后只能使用 `https://aihot.news/api/v1`。osmosis 的 `aihot` 源目前完全依赖旧接口，不迁移则 10-31 起整源断流。

v1 不是换域名的平替（`take`/`since` 参数被拒、日报路径与响应结构变化），反正要重写请求层；同时 v1 新增的 `/api/v1/selected/changes` 账本接口能直接观测「入选」事件，解决了现行「粗窗口 + 已推送集合」模型「入选时间不可观测、任何窗口都无法保证零丢失」的根本缺陷，因此一次性迁移到账本模型。

## What Changes

- **BREAKING（外部依赖）** 日报改为 `GET https://aihot.news/api/v1/dailies/{date}`，解析 `{schemaVersion, report}` 包装与 v1 字段（`source.name`、`links.aihot`、`links.original`）。
- 精选主路径改为账本增量：读取上一次同步写下的 cursor，调用 `GET /api/v1/selected/changes` 翻页拉取自上次以来的入选变更；精选不再受 `publishedAt` 窗口约束。
- 新增**通用**跨运行状态通道：`FetchResult.syncState` 由 formatter 写入 markdown frontmatter `sync_state`；`FetchContext.getLastSyncState()` 从「title 日期最新」的已同步 PR 读回。不引入数据库/持久化存储，状态仍「问 GitHub」。
- 无可用 cursor（首次迁移、`409 snapshot_required`、状态读取失败）时走兜底：`/api/v1/items?mode=selected&window=7d&by=timeline` + 已推送集合去重，并用 `/api/v1/selected/snapshot?limit=1` 建立新水位。
- 账本路径翻页触顶时写入「最后已应用页」的 cursor，次日续读；**移除**主路径的「已达单次抓取上限」截断提示（兜底路径保留可见截断提示）。
- 已推送集合去重键改为「条目 id（从 `/items/{id}` 提取，兼容新旧两个域名）+ 原文 url」。
- **移除** `lastSyncedAt` + 48h 粗窗口计算（`computeSinceIso`）及 `FetchContext.lastSyncedAt` / `SyncStatus.lastSyncedAt`（唯一消费者是 aihot）。
- `sourceUrl`、`subscriptions/aihot.yml` frontmatter `source` 改为 `https://aihot.news/`。
- 不渲染 v1 新增的 `reason` 字段。
- 文档：重写 `CLAUDE.md` 中 aihot 两段说明，更新 `contributing/add-fetcher.md` 示例。

## Capabilities

### New Capabilities

- `fetch-sync-state`: fetcher 跨运行状态通道——`FetchResult.syncState` 写入 frontmatter `sync_state`，下一次运行经 `FetchContext.getLastSyncState()` 从最新已同步 PR 读回；回填运行不写入。

### Modified Capabilities

- `aihot-fetcher`: 数据源迁移到 `aihot.news/api/v1`；日报端点/结构变更；精选获取由时间窗口改为 `selected/changes` 账本 + 兜底窗口；去重键、截断语义、`sourceUrl` 变更。

## Impact

- 代码：`src/fetchers/aihot.ts`（重写请求与精选逻辑）、`src/fetchers/types.ts`、`src/formatter.ts`、`src/index.ts`、`src/dedup.ts`、`src/pr-listing.ts`（新增读取最新 PR `sync_state`）及对应测试。
- 配置：`subscriptions/aihot.yml`。
- 下游 vault：aihot 笔记 frontmatter 新增 `sync_state` 字段（其它源不受影响，不写则不出现）。
- 外部依赖：`https://aihot.news/api/v1`（匿名、只读，仍需自定义 User-Agent）。无新 npm 依赖。
- 时间约束：目标 2026-10-20 前合入，至少留一次真实 cron 运行验证首日兜底 → 次日账本切换。
