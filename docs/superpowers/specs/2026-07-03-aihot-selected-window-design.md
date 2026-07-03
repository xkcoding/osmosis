# aihot 精选池推送窗口重构 — 设计文档

日期：2026-07-03
状态：待评审

## 背景与问题

AI HOT 源的推送存在系统性遗漏。整条流水线是"每源每天一张快照"模型：每小时 cron 第一次发现 `daily/{date}` 可用（日报在 UTC 午夜 = 北京时间 08:00 一次性生成）就抓取、开 PR、推卡片；之后当天所有运行被 `isAlreadySynced` 跳过。

日报本身是完整快照，没有遗漏。**真正流式、被漏掉的是精选池**：

1. `src/fetchers/aihot.ts` 用 `since=今天 UTC 午夜` 拉精选池，而抓取发生在北京时间 08 点刚过——窗口才开几分钟，精选池几乎是空的。前一天 08:00 之后入选的条目永远落在相邻两个窗口的缝隙里。
2. `SELECTED_TAKE = 20` 低于服务端默认值 50（上限 100），且响应里的 `hasNext`/`nextCursor` 被忽略，没有翻页能力，窗口内条目超过 20 条也会截断。

依据：`https://aihot.virxact.com/openapi.yaml`（v1.1.0）。排序契约为 `publishedAt` 倒序，官方明确"按 publishedAt 做去重和窗口查询是契约红线"。

## 决策

核心目标是把"条目随时入选"的**连续流**离散成**日快照**且零遗漏。API 只能按 `publishedAt`（发布时间）做窗口查询，而流的真实事件轴是**入选时间**——两轴错位（条目可先发布、后入选；spec 自己警告慢推 RSS 源有时间撕裂）。因此**任何按时间精确分窗的方案都存在结构性遗漏**，正确解法是：

**粗窗口 + 精确集合去重**：

- 窗口放粗到足以覆盖任何现实的入选滞后：`since = min(lastSyncedAt, now − 48h)`，clamp 到 `now − 7d`（API 硬上限）。cron 漏跑多天时 `lastSyncedAt` 自动拉长窗口补缺口。
- 去重不靠时间靠**已推送条目集合**：回读最近几个已同步 aihot PR 的 markdown，提取站内 permalink（`/items/{id}`，条目稳定 id）与原文 url 作为去重键集合，窗口内已推过的条目直接丢弃。

状态来源仍是"问 GitHub"（PR `createdAt` + PR 文件内容），零新状态、无数据库。

范围外（明确不做）：

- 不加 `hot-topics` 区块（瞬时排行与快照模型语义不同，后续单独考虑）。
- 不改两个 label 的幂等机制、一源一卡约定、workflow、其他源。
- 不做当天增量补推（如需时效性，后续在此基础上叠加）。

## 详细设计

### 1. dedup 查询扩展（`src/dedup.ts`）

`isAlreadySynced` 重构为 `getSyncStatus(query): Promise<{ syncedToday: boolean; lastSyncedAt: string | null }>`：

- 同一次 `gh pr list`（labels `auto-sync,source:<name>`、`--state all`）的 `--json` 增加 `createdAt`。
- `syncedToday`：现有逻辑不变（OPEN/MERGED 且标题含当天日期）。
- `lastSyncedAt`：OPEN/MERGED PR 中最大的 `createdAt`（不限日期），无则 `null`。

### 2. Fetcher 上下文（`src/fetchers/types.ts`、`src/index.ts`）

```ts
export interface FetchContext {
  lastSyncedAt?: string
  // 懒加载：最近 n 个已同步 PR 的 markdown 内容（新→旧），仅需要历史的 fetcher 调用
  getRecentSyncedContents?: (n: number) => Promise<string[]>
}
// Fetcher.fetch(config: SourceConfig, ctx?: FetchContext)
```

`runFetch` 传入 `lastSyncedAt` 与基于 `fetchPrFile`（`src/pr-listing.ts`，复用）实现的懒加载回调。fetcher 不直接碰 gh，分层不破；通用机制，其他 fetcher 忽略即可，不特判源名。

### 3. aihot fetcher 抓取逻辑（`src/fetchers/aihot.ts`）

**窗口（粗，只负责"必然覆盖"）**：

- `since = min(lastSyncedAt, now − 48h)`，clamp 到 `now − 7d`；无 `lastSyncedAt` → `now − 48h`。
- 48h 重叠覆盖入选滞后；重叠产生的重复由下面的集合去重消除，不依赖时间精度。

**已推送集合（准，负责"必然不重"）**：

- 经 `ctx.getRecentSyncedContents(3)` 回读最近 3 个已同步 PR 的 markdown（3 × 24h ≥ 窗口 48h + 余量）。
- 用正则提取两类键：站内 permalink `aihot.virxact.com/items/{id}`（精确、稳定）与所有 markdown 链接 url。
- 回读失败（gh 出错等）不阻塞抓取：降级为空集合，宁可偶尔重复不因此漏推，记 warn 日志。

**翻页拿全**（`mode=selected`）：

- `take=100`，用响应 `nextCursor` 翻页。
- 终止：页内出现**非 null** `publishedAt < since` 的条目即停（该条目及更旧的全部丢弃）；`publishedAt` 为 null 的条目跳过、不参与终止判定。
- 防护（cursor 失效会静默回首屏而不报错）：按条目 `id` 去重；整页无新 id 即停；最多 5 页硬上限。
- 页间 200ms 间隔（spec 建议）。

**429 处理**：`getJson` 遇 429 退避 1.5 秒重试一次，仍失败按现有降级路径处理（daily 抛错、selected 降级为空）。

### 4. 渲染与去重

**去重规则（统一）**：每个条目产出**两个键**——`permalink` 与原文 `url`——全部入集合，**任一命中即视为重复**。不使用 `permalink ?? url` 单键（daily sections 的 permalink 可为 null，混合单键会失配漏去重）。精选条目依次对比：① 已推送集合（历史 PR）；② 当天日报 sections / flashes 的键集合（撞上时保留日报版，它带 LLM 摘要）。需要为 `DailySectionItem`/`DailyFlash` 接口补充 `permalink` 字段。

**双链接格式**（日报 sections、精选池、快讯统一）：

- 有 permalink：`- [标题](permalink) — 来源名（[原文](原始url)）`
- 无 permalink：`- [标题](原始url) — 来源名`

标题链到 AI HOT 站内阅读页（中文翻译 + 无 X/付费墙），「原文」链到第三方原始 URL。

**精选池区块标题**：从「🔥 精选池（过去 24 小时）」改为「🔥 新入选精选」（窗口不再固定 24 小时）。

**其余不变**：notify body 20KB 截断、daily 404 返回 null（当天日报缺失时整源跳过——该天的精选条目由下一次推送的窗口自动覆盖，不丢失）。

## 错误处理小结

| 场景 | 行为 |
|---|---|
| daily 404 / error body | 返回 null，当天跳过；精选缺口由下次窗口补上 |
| selected 端点非 429 错误 | 现状保留：降级为 daily-only |
| 429（daily 或 selected） | 退避 1.5s 重试一次，再失败走上一行 |
| cursor 静默回首屏 | id 去重 + 整页无新 id 即停 + 5 页硬上限 |
| `lastSyncedAt` 超过 7 天 | since clamp 到 now − 7d（同服务端硬上限行为一致） |
| `publishedAt` 为 null | 条目跳过，不参与翻页终止判定 |
| 回读历史 PR 失败 | 去重集合降级为空，宁重勿漏，记 warn |

## 测试计划（`src/fetchers/aihot.test.ts` 扩展）

1. 翻页在非 null `publishedAt < since` 边界正确终止且过滤旧条目；null `publishedAt` 条目被跳过且不触发终止。
2. cursor 回首屏（返回重复 id）时循环终止；5 页硬上限生效。
3. 双键去重：历史 PR 中仅出现原文 url（无 permalink）时，同条目的精选（有 permalink）仍被判重；反向亦然。
4. 精选与当天日报撞条目时保留日报版。
5. 窗口计算：`min(lastSyncedAt, now − 48h)`、7 天 clamp、无 `lastSyncedAt` 回退 `now − 48h`。
6. `getRecentSyncedContents` 抛错时降级为空集合，抓取不中断。
7. 双链接渲染：有/无 permalink 两种格式。
8. 429 重试一次后成功 / 仍失败降级。
9. `getSyncStatus`：`syncedToday` 与 `lastSyncedAt` 的组合场景（`src/dedup.ts` 对应测试）。

验收：`pnpm check` 全绿。
