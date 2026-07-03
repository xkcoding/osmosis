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

精选池窗口改为**推送时刻到推送时刻无缝拼接**（push-to-push tiling）：每次抓取拉「上次推送之后 → 现在」的全部精选条目。不依赖上游窗口定义；cron 漏跑一天，下一次推送自动补上缺口（items API `since` 上限 7 天，自动截断）。

"上次推送时间"来源：**上一个已同步 PR 的 `createdAt`**——沿用"去重模型 = 问 GitHub"的约定，零新状态、无数据库。

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
  lastSyncedAt?: string  // ISO datetime，本源上一个已同步 PR 的创建时间
}
// Fetcher.fetch(config: SourceConfig, ctx?: FetchContext)
```

`runFetch` 把 `getSyncStatus` 返回的 `lastSyncedAt` 传入。通用机制，其他 fetcher 忽略该参数——符合插件架构，不特判源名。

### 3. aihot fetcher 抓取逻辑（`src/fetchers/aihot.ts`）

**窗口**：

- `since = lastSyncedAt − 30min`（缓冲覆盖上次"抓取 → PR 创建"的间隙及轻微入选滞后）。
- 无 `lastSyncedAt`（首次运行 / 7 天内无 PR）→ 回退 `now − 24h`。
- 已知权衡：缓冲窗口内昨天已推过的精选条目可能重复出现一次（卡片内去重只对比当天日报，不回读昨天的推送内容）。概率低、代价小，v1 接受；如实际观察到再叠加"回读上一 PR 文件按 url 去重"。

**翻页拿全**（`mode=selected`）：

- `take=100`，用响应 `nextCursor` 翻页。
- 终止：页内出现 `publishedAt < since` 的条目即停（该条目及更旧的全部丢弃）。
- 防护（cursor 失效会静默回首屏而不报错）：按条目 `id` 去重；整页无新 id 即停；最多 5 页硬上限。
- `publishedAt` 为 null 的条目跳过（无法参与窗口判定，避免跨天重复推送）。
- 页间 200ms 间隔（spec 建议）。

**429 处理**：`getJson` 遇 429 退避 1.5 秒重试一次，仍失败按现有降级路径处理（daily 抛错、selected 降级为空）。

### 4. 渲染与去重

**卡片内去重**：精选条目若已出现在当天日报 sections 中则丢弃（日报版带 LLM 摘要，优先保留）。去重 key = `permalink ?? url`（同一条目在两个端点的 permalink 同源 `/items/{id}`，比第三方 url 更可靠）。需要为 `DailySectionItem`/`DailyFlash` 接口补充 `permalink` 字段。

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
| `lastSyncedAt` 超过 7 天 | 服务端自动把 since 截到 7 天前，正常返回 |
| `publishedAt` 为 null | 条目跳过 |

## 测试计划（`src/fetchers/aihot.test.ts` 扩展）

1. 翻页在 `publishedAt < since` 边界正确终止且过滤旧条目。
2. cursor 回首屏（返回重复 id）时循环终止。
3. 精选条目与日报 sections 按 `permalink ?? url` 去重。
4. 双链接渲染：有/无 permalink 两种格式。
5. 无 `lastSyncedAt` 时回退 `now − 24h`。
6. 429 重试一次后成功 / 仍失败降级。
7. `getSyncStatus`：`syncedToday` 与 `lastSyncedAt` 的组合场景（`src/dedup.ts` 对应测试）。

验收：`pnpm check` 全绿。
