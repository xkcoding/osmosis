## 1. 通用同步状态通道（fetch-sync-state）

- [x] 1.1 `src/fetchers/types.ts`：`FetchResult` 新增 `syncState?: Record<string, string>`；`FetchContext` 新增 `getLastSyncState?: () => Promise<Record<string, string> | undefined>`，删除 `lastSyncedAt`；`pnpm typecheck` 暴露的引用点在后续任务中处理
- [x] 1.2 `src/formatter.ts`：`syncState` 非空时写入 `fm.sync_state`，空或缺失时不写；在 `src/formatter.test.ts` 补「携带 / 不携带 / 空映射」三个用例并通过
- [x] 1.3 `src/pr-listing.ts`：新增 `fetchLastSyncState(targetRepo, source)`，复用 `fetchRecentSyncedContents(…, 1)` 解析 frontmatter `sync_state`（只保留字符串值；缺失、无 PR、YAML 坏掉都返回 `undefined`）；在 `src/pr-listing.test.ts` 覆盖「含状态 / 无状态 / 回填 PR 创建更晚但 title 日期更早」并通过
- [x] 1.4 `src/dedup.ts`：删除 `SyncStatus.lastSyncedAt` 及其计算；更新 `src/dedup.test.ts` 并通过
- [x] 1.5 `src/index.ts`：构造 `FetchContext` 时去掉 `lastSyncedAt`，注入懒加载的 `getLastSyncState`；`pnpm typecheck` 通过

## 2. aihot 请求层与日报迁移

- [x] 2.1 `src/fetchers/aihot.ts`：`BASE_URL` 改为 `https://aihot.news/api/v1`，保留 UA 与 429 重试一次；按 v1 schema 重写类型（`Item.links.{aihot,original}`、`source.name`、`DailyResponse.report`、`SelectedChanges`、`SelectedSnapshot`、`ItemsResponse.page`），并提供 404/409 可识别的取数助手；单测断言所有请求 URL 以 `https://aihot.news/api/v1/` 开头且带 `osmosis/` UA
- [x] 2.2 日报改为 `GET /dailies/{date}`，从 `report` 渲染（字段映射改为 `source.name` / `links.aihot` / `links.original`）；404 返回 null 且不请求精选，500 抛错；更新对应测试并通过
- [x] 2.3 `sourceUrl` 改为 `https://aihot.news/`；更新 FetchResult 不变量测试并通过

## 3. 精选：账本主路径 + 兜底

- [x] 3.1 实现账本路径：`changes?cursor=…&limit=100` 翻页（`MAX_PAGES`、页间隔），收集 upsert（剔除 `selected === false`、同 id 只留最后一次）、剔除同批后续 remove、忽略批外 remove，按 `changedAt` 反转为新→旧；返回 `{items, cursor: lastApplied}`；测试覆盖「增量读取」「同批 remove」「触顶写 Cn 且无截断提示」「首页 503 保留 C0」「中途失败保留已应用页」
- [x] 3.2 实现兜底路径：先 `selected/snapshot?limit=1` 取 cursor，再 `items?mode=selected&window=7d&by=timeline&limit=100` 按 `page.nextCursor` 翻页（id 去重、无新 id 停止、页数上限，触顶带截断标记）；snapshot 失败时不写 syncState；测试断言请求顺序为先 snapshot 后 items，并覆盖「首次迁移」「snapshot 失败」「兜底触顶提示」
- [x] 3.3 路径选择：非回填运行时调用 `ctx.getLastSyncState()`（抛错或无 cursor 时走兜底），账本返回 409 时转兜底；回填（`isDatePinned()`）不读状态、不请求精选、不写 syncState；删除 `computeSinceIso` 及相关常量；测试覆盖「409 转兜底」「getLastSyncState 抛错转兜底」「无 ctx（本地）走兜底」「回填只请求日报」
- [x] 3.4 去重改造：历史 markdown 与日报中提取 id（同时认 `aihot.news` 和 `aihot.virxact.com` 的 `/items/{id}`）以及原文 url；候选键为 `item.id` 和 `item.links.original`；读历史失败时降级为空集合；测试覆盖「旧域名历史去重」「原文 url 命中日报」「已编辑条目不重推」「读取失败降级」
- [x] 3.5 渲染：精选行改用 `links.aihot` / `links.original` / `source.name`，不渲染 `reason`；截断提示只在兜底触顶时出现，文案改为不承诺「次日补收」；FetchResult 带上 `syncState: { cursor }`；`pnpm test src/fetchers/aihot.test.ts` 全部通过

## 4. 配置与文档

- [x] 4.1 `subscriptions/aihot.yml` frontmatter `source` 改为 `https://aihot.news/`；`pnpm test` 中的订阅加载测试通过
- [x] 4.2 重写 `CLAUDE.md` 的 aihot 两段说明（v1 端点与坑：UA、`limit`/`window`、cursor 语义、409、日报 404 与上海日期；账本模型 + `sync_state` + 兜底 + 去重键），删除 `lastSyncedAt` 粗窗口描述，并更新 `OSMOSIS_DATE` 段里对 `lastSyncedAt` 的引用；`grep -n "virxact\|lastSyncedAt\|api/public" CLAUDE.md` 只剩「旧域名 id 兼容」相关的说明
- [x] 4.3 `contributing/add-fetcher.md`：示例 `sourceUrl` 改为新域名，补充 `syncState` / `getLastSyncState` 的用法说明；人工核对链接与示例一致

## 5. 验证

- [x] 5.1 `pnpm check`（typecheck + lint + test）全部通过
- [x] 5.2 本地 smoke：`pnpm fetch --subscription aihot --output-dir /tmp/vault`（不设 `TARGET_REPO`，走兜底），确认产物含日报和精选、frontmatter 含 `sync_state.cursor`、链接为 `aihot.news`；结束后删除 `/tmp/vault`
- [x] 5.3 本地 smoke 账本路径：用 5.2 得到的 cursor 手动请求 `changes`，确认返回 200 且结构与实现假设一致（`changes[].op/item.links`）
- [x] 5.4 `openspec validate migrate-aihot-v1-ledger --strict` 通过
