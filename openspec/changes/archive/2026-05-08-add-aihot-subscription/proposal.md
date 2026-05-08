## Why

AI HOT (`aihot.virxact.com`) 提供高质量的中文 AI 资讯精编服务：每日 08:00 北京时间产出结构化日报，并维护一个滚动精选池。该源是日报+精选双形态，且暴露严格 OpenAPI 3.1 REST 接口（含字段不变量、稳定 schema、剥离评分/AI 标签等元数据），相较 RSS 信噪比和可用性显著更高。

把它作为 osmosis 的第三个订阅源接入，可以补足现有 builderpulse / juya-ai-daily 之外的「中文 AI 行业全景」覆盖面。同时 AI HOT 日报本身已是精编成品（含 `lead.leadParagraph` 与 5 段固定结构），无需再走 LLM 二次摘要——这要求 osmosis 首次支持「无摘要直发」的通知路径。

## What Changes

- 新增 `aihot` fetcher 类型，调用 `/api/public/daily/{date}` 与 `/api/public/items?mode=selected&since={today00:00Z}&take=20` 两个端点，合并为单篇 markdown 输出。日报 404 时返回 `null`（osmosis 已有的「今日无内容」契约），整张卡片当日跳过；精选 API 失败时降级为仅日报内容。
- 所有出站请求强制设置自定义 `User-Agent`（裸 `curl/x.y.z` 会被 nginx 黑名单 403）。
- 新增 `subscriptions/aihot.yml`，输出到 Obsidian `00_Inbox/Clippings/{date} - AI HOT.md`，标签 `clipping/aihot, AI, news`，通知 `wecom + feishu`。
- **BREAKING**（行为扩展，非 API 破坏）：`output.notify.summary: false` 当前会让 summarize 阶段跳过该源，导致 IM 卡完全不发出。本次扩展该路径，使其支持「pre-baked card body」——fetcher 产出可直接用作 IM 卡正文的字段，summarize 阶段在跳过 LLM 调用的同时仍把该源纳入 `summary-sections.json`，由 notify 正常推送。现有两个订阅默认 `summary: true`，行为不变。
- 不引入新的 npm 依赖（继续用 `fetch` + 内建 JSON 解析）。

## Capabilities

### New Capabilities

- `aihot-fetcher`: 专用于 AI HOT REST API 的 fetcher 能力，封装日报+精选双端点合并、UA 注入、404 即 null、精选降级等不变量。

### Modified Capabilities

- `notifier`: 扩展「无 LLM 摘要直发」通知路径。允许 fetcher 通过预定字段提供 IM 卡正文，summarize 阶段在 `notify.summary: false` 时复用该字段而非跳过该源。

## Impact

- 代码：
  - `src/fetchers/aihot.ts`（新增）
  - `src/fetchers/registry.ts`（注册新类型）
  - `src/fetchers/types.ts`（`FetchResult` 增加可选 `notifyBody`）
  - `src/index.ts` summarize 分支（在 `notify.summary === false` 路径读取 PR 文件中的 notify body）
  - `src/formatter.ts`（在 markdown frontmatter 或专属字段里持久化 `notifyBody`，供 summarize 反向读取）
- 配置：
  - `subscriptions/aihot.yml`（新增）
- 测试：
  - `src/fetchers/aihot.test.ts`（新增；mock fetch、覆盖 404、UA、合并、精选降级）
  - 扩展 `src/index.test.ts` 或新增测试覆盖「no-summary 路径仍出 section」
- 文档：
  - `contributing/add-fetcher.md` 增补「pre-baked notify body」段落
  - `CLAUDE.md` 「Memory-style notes」补一条 AI HOT API 不变量提醒（UA 必带、cursor 黑盒、7 天窗口）
- 运行时：无新外部依赖，无新 secret（API 匿名只读）。
- 风险：notify body 通过 PR 文件携带使 markdown 多出一段元数据（frontmatter 内字段或 HTML 注释），需保证 Obsidian 渲染不破坏；测试中需明确该字段不被 summarize 之外的链路误用。
