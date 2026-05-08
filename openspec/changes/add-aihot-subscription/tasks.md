> **TDD 流程**：每节内先写测试（红），再补最小实现让测试通过（绿），最后重构。每节内 `.test.ts` 任务必须先勾选并实际看到 fail，才能勾选实现任务。

## 1. 类型契约扩展（formatter 持久化 notify_body）

- [x] 1.1 🔴 扩展 `src/formatter.test.ts`：新增两条 round-trip 用例
  - fetcher 提供 `notifyBody: "## hello"` → 输出 markdown frontmatter 含 `notify_body: |` 多行块；用 `yaml.parse` 反向解析后 `parsed.notify_body === "## hello\n"` 或等价
  - fetcher 不提供 `notifyBody` → frontmatter 不含 `notify_body` 键
  - 运行测试，确认两条 fail
- [x] 1.2 🟢 在 `src/fetchers/types.ts` 的 `FetchResult` 增加 `notifyBody?: string`
- [x] 1.3 🟢 在 `src/formatter.ts` 处理 `notifyBody`：非空时写入 frontmatter；空 / undefined 不写入
- [x] 1.4 ✅ 重新运行 `pnpm test src/formatter.test.ts`，新两条用例通过；既有用例不退化

## 2. summarize 路径扩展（pre-baked notify body）

- [x] 2.1 🔴 新增 `src/summarize-section.test.ts`（pure-function 测试，无 fs/network mock 需求），覆盖
  - `summary:false + frontmatter 含 notify_body` → `summary-sections.json` 含该 section 且 `summary === notify_body` 文本；LLM 未被调用
  - `summary:false + 无 notify_body` → section 不入数组，LLM 未被调用
  - `summary:true + frontmatter 含 notify_body` → 走 LLM，section.summary === LLM 输出
  - 运行测试，确认全部 fail（或现有代码无法通过）
- [x] 2.2 🟢 抽出纯函数 `buildSection` 到 `src/summarize-section.ts`；改造 `src/index.ts` summarize 循环复用之
- [x] 2.3 🟢 frontmatter 解析复用 `yaml` 包；try/catch 返回 undefined 安全降级
- [x] 2.4 ✅ 测试全绿；typecheck 通过

## 3. aihot fetcher 实现

- [x] 3.1 🔴 新增 `src/fetchers/aihot.test.ts`，mock global `fetch`，覆盖
  - 日报 404 → `fetcher.fetch(cfg)` 返回 `null`；assert 精选端点未被请求
  - 日报 200 + 精选 200（含 lead / 含至少 1 个 section / 含 flashes / 含 items）→ result.content 含两段 markdown；result.notifyBody 非空且不含字符串 `精选池`；result.title === `'AI HOT 日报'`；result.sourceUrl === `'https://aihot.virxact.com/'`
  - 日报 200 + 精选 503 → 仅日报段；不抛异常
  - 日报 200 + lead === null → markdown 不含 blockquote；不出现 `null` 字面量
  - 全 5 段 section.items 为空 + flashes 为空 → 不出现空二级标题
  - 精选 item.summary === null → 该条仅标题行
  - notifyBody 超 4 KB → 截断后以 `…\n（已截断）` 结尾
  - 所有出站请求 headers 含 `User-Agent: osmosis/...`，且不以 `curl/` / `node` 开头
  - 日报 5xx → 抛异常（含状态码 + 端点路径）
  - 运行测试，确认全部 fail
- [x] 3.2 🟢 创建 `src/fetchers/aihot.ts`：UA 常量 + base URL 常量
- [x] 3.3 🟢 实现 `fetchDaily(date)`：404 / `error` 体 → null；2xx → typed 对象；5xx 抛错
- [x] 3.4 🟢 实现 `fetchSelected(sinceUtcMidnightIso)`：失败返回 `[]` + console.error
- [x] 3.5 🟢 实现 `renderDailyMarkdown` / `renderSelectedMarkdown` / `renderNotifyBody`（空段省略、null 降级、4 KB 截断）
- [x] 3.6 🟢 实现 `aihotFetcher.fetch`：组装 `today` (`todayParts().date`) + `sinceUtcMidnightIso` (今天 00:00:00.000Z) → 串行调用 → 合并 → 返回 `FetchResult`
- [x] 3.7 🟢 在 `src/fetchers/registry.ts` 注册 `aihotFetcher`
- [x] 3.8 ✅ `pnpm test src/fetchers/aihot.test.ts` 全绿

## 4. 配置 + 端到端验证

- [x] 4.1 创建 `subscriptions/aihot.yml`（参考 design.md 结构；`summary: false`；`take=20` 由 fetcher 内部硬编码）
- [x] 4.2 `pnpm check` 全部通过（typecheck + lint + 全部测试）
- [ ] 4.3 本地 smoke：北京 08:00 后运行 `GITHUB_TOKEN=ghp_xxx TARGET_REPO=xkcoding/second-brain pnpm fetch --subscription aihot --output-dir /tmp/vault`，检查
  - 输出文件名 `2026-XX-XX - AI HOT.md`
  - frontmatter 含 `notify_body: |` 块
  - markdown 含 lead + 至少一个 section + 精选池
- [ ] 4.4 northwest 边界 smoke：在北京 08:00 前手动调用日报端点确认 404 路径（或 mock 注入）→ fetcher 返回 null

## 5. 重构与文档

- [x] 5.1 重构：常量与 typed 守卫已位于 `src/fetchers/aihot.ts` 模块顶部，单文件
- [x] 5.2 在 `contributing/add-fetcher.md` 增补「pre-baked notify body」章节，示范 `notifyBody` 字段用法
- [x] 5.3 在 `CLAUDE.md` 的「Memory-style notes」末尾追加 AI HOT API 不变量提醒（UA 必带、cursor 黑盒、7 天窗口、limit 600/min）+ pre-baked notify body 说明
- [ ] 5.4 archive 阶段在 `openspec/specs/fetcher/spec.md`「已规划的 Fetcher 类型」表格补 `aihot` 行（apply 阶段不动 specs/，留给 archive）

## 6. 验收

- [x] 6.1 `pnpm check` 全部通过
- [ ] 6.2 PR 触发 CI 通过
- [ ] 6.3 合并后等待下一次 hourly cron 验证端到端（PR 创建 + IM 卡推送）
