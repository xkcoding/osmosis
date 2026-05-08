## Context

osmosis 当前两个订阅（builderpulse / juya-ai-daily）都依赖 LLM 二次摘要：fetcher 抓内容 → quality 校验 → 写入 Obsidian PR → summarize 阶段调 LLM 出 IM 卡正文 → notify 推送。该流程对 RSS / 文件型源是必要的（原始内容信噪比不够），但对 AI HOT 这类「服务侧已精编、API 直接给出 lead+sections 的源」反而是浪费——LLM 二次概括会损失结构信息、增加成本与延迟。

AI HOT REST API 的关键约束（来自其公开文档）：
- 必须自定义 `User-Agent`，否则 nginx 黑名单返回 403。
- 日报端点 `/api/public/daily/{YYYY-MM-DD}` 在该日尚未生成时返回 404（错误体 `{ "error": "No daily report for ..." }`）。
- 精选端点 `/api/public/items?mode=selected&since=ISO&take=N`：`take` 上限 100，`since` 早于 7 天前自动截断，未来时间 400。
- 字段不变量：日报固定 5 个 section label（"模型发布/更新" / "产品发布/更新" / "行业动态" / "论文研究" / "技巧与观点"），section.items / flashes 可空数组；items 端点的 `title_en` / `summary` / `publishedAt` / `category` 可为 null。
- 限速 600 req/min/IP，本场景每天个位数请求，远低于阈值。

osmosis 的不变量同样需要尊重：
- fetcher 返回 `null` = 「今日无内容」，整张卡跳过（`CLAUDE.md` 明列）。
- 时区统一走 `OSMOSIS_TZ`（默认 `Asia/Shanghai`），所有「今天」经 `todayParts()`。
- `output.notify.summary === false` 当前在 `src/index.ts:195` 直接 `continue`，使该源不进入 `summary-sections.json` → notify 阶段无卡。本次设计需扩展该路径。
- 插件架构：`src/index.ts` / `src/config.ts` 不能 special-case 源名。

## Goals / Non-Goals

**Goals:**
- 单一订阅 `aihot` 同时聚合「日报 + 当日精选」为一篇 markdown，一个 PR，一张 IM 卡。
- 日报 404 → 整张卡跳过当日（不发"半张"）。
- IM 卡正文直接来自 API（`lead.title` + `lead.leadParagraph`），不调 LLM。
- 通用化：「pre-baked notify body」机制必须可被未来源复用，不是 aihot 专属。
- 现有 builderpulse / juya-ai-daily 行为零变更。

**Non-Goals:**
- 不接 `mode=all` 端点（信噪比低 + 与精选高度重叠）。
- 不做指定历史日期补抓（`/api/public/daily/{date}` 虽支持，但日常 cron 只取「今天」即可；未来若需要可单开 change）。
- 不做关键词搜索 / category 过滤（仅默认 selected 池）。
- 不做 Obsidian 端结构化字段渲染（5 段 + flashes + 精选池一律拼成 markdown，按现有 formatter 写入）。
- 不引入新 npm 依赖。

## Decisions

### 1. 拆分为两次串行 API 调用，不并发

- 选项 A（采用）：先 `GET /daily/{today}`，404 立即返回 `null`；200 后再 `GET /items?mode=selected&since={today00:00Z}&take=20`，精选失败则降级为「仅日报」。
- 选项 B：并发两次请求，事后合并。
- 理由：日报是触发条件，精选是增强信息。串行让「日报缺席就整体跳过」语义最清晰，且每天个位数请求量并发收益可忽略。降级策略保证精选服务暂时抖动不影响主路径。

### 2. UA 注入位置：fetcher 局部，不全局

- 选项 A（采用）：`aihot.ts` 内部硬编码 UA，仅本 fetcher 的 `fetch()` 调用使用。
- 选项 B：在某个 http 工具层全局注入。
- 理由：现有 `rss.ts` / `github-file.ts` 各自调用 `fetch`，没有共享 http 层。为单一源临时引入全局工具属于过度抽象（违反 KISS）。UA 字符串建议形如 `osmosis/1.0 (+https://github.com/xkcoding/osmosis)`，可识别且符合 robots 礼仪。

### 3. 「无 LLM 摘要直发」机制：FetchResult 增加 `notifyBody` + 通过 frontmatter 持久化

`FetchResult` 增加可选字段：

```ts
export interface FetchResult {
  title: string
  date: string
  content: string
  sourceUrl: string
  notifyBody?: string  // 新增：预先渲染好的 IM 卡正文（markdown）
}
```

`formatForObsidian` 在 frontmatter 里持久化：

```yaml
---
title: AI HOT — 2026-05-08
date_saved: 2026-05-08
notify_body: |
  > {leadParagraph}
  
  ## 模型发布/更新
  ...
...
---
```

`summarize` 阶段（`src/index.ts:184` 的循环）改造：

- 拉取 PR 文件后先解析 frontmatter。
- 若 `subscription.output.notify?.summary === false`：
  - 若 frontmatter 含 `notify_body` → 用该字段作为 section 文本，跳过 LLM。
  - 若不含 → 维持现状（continue，跳过该源）——保留向后兼容的"完全静默"语义。
- 若 `notify.summary !== false`：照常调 LLM。

**为何选择 frontmatter 而非 sidecar 文件**：
- 不需要 fetcher 多写一个文件 → PR diff 干净，仍是单一 markdown 文件。
- summarize 阶段已经 `fetchPrFile`，复用同一 GET，不增加 GitHub API 调用。
- Obsidian 对未知 frontmatter 字段是兼容的（仅显示已知字段，其他原样保留）。
- 风险点：`notify_body` 较长会让 frontmatter 体积增大，但纯文本，无格式风险。

**替代方案**：在 markdown 末尾加 `<!-- osmosis:notify-body -->` HTML 注释包围块。被否：解析需要正则，比 YAML 解析脆，且会出现在某些 markdown 渲染中。

### 4. 精选 markdown 渲染：拼接到日报后面

```markdown
> {lead.leadParagraph}

## 🚀 模型发布/更新
- [{title}]({sourceUrl}) — {sourceName}
  {summary}

## 📦 产品发布/更新
... （items 为空段省略）

## 📰 行业动态
...

## 📑 论文研究
...

## 💡 技巧与观点
...

## ⚡️ 快讯
- [{title}]({sourceUrl}) — {sourceName}

---

## 🔥 精选池（过去 24 小时）
- [{title}]({url}) — {source}
  {summary}
```

- 5 个 section label 的 emoji 仅用于视觉分组，文本来自 API 不变量。
- `items` 数组为空的 section 整段省略（避免 IM 卡片里出现"暂无"占位行）。
- IM `notify_body` 仅取「日报部分」（lead + sections + flashes），**不含**精选池——精选条目数量多，IM 卡里塞不下，留给 PR 阅读体验。

### 5. 精选时间窗：`since=今晨00:00Z`（UTC），take=20

- 选 UTC 0 点而非北京 0 点：API 的 `publishedAt` 是 ISO 8601 UTC，对齐 UTC 边界让翻页/对比更直观；中午 12:00 BJT 时已是 UTC 04:00，`since=今天00:00Z` 等价"过去 4-12 小时滚动池"，对中文读者足够新鲜。
- take=20：用户拍板。低于 50（默认）减少噪音；高于 10 给"精选池"留够余地。

### 6. 不调 LLM 的 quality gate 处理

- `src/quality.ts` 当前在 fetcher 与 write 之间运行（`CLAUDE.md` 明列）。aihot 内容来自精编 API，理论上质量很稳，但仍走默认 quality 规则——若有边缘 case 命中可在 yaml 的 `quality:` block 局部放宽。先不预设豁免。

### 7. 调度：依赖既有 hourly cron + idempotency 标签

- 用户提到「中午 12 点左右尝试」。设计上不引入新 cron：
  - 日报 08:00 BJT 生成 → 现有 hourly cron 在 08:00 后第一次跑成功。
  - 失败时返回 `null`，后续小时继续重试。
  - 同日成功后，`auto-sync + source:aihot` + `summary-sent` 双标签防重。
- 若用户后续真的想限定"只在中午尝试"，可在 `aihot.ts` 内加 BJT < 12 时返回 null 的小时门——但属于优化，本次不做。

## Risks / Trade-offs

- **Frontmatter 体积**：`notify_body` 拼出的 markdown 在内容多的天可能 1-2 KB → frontmatter 整体 2-3 KB。Obsidian 与大多数 markdown 渲染器无压力，但下游解析 YAML 时需注意多行 `|` 块字符串。  
  **→ Mitigation**：`formatter` 用 `yaml` 包的 `stringify`（已是默认）让多行字符串自动走 `|` 块格式；测试覆盖 round-trip 解析。

- **API 形态变更**：AI HOT 是第三方公开 API，schema 不变量靠对方承诺。一旦字段命名或可空性变更，aihot fetcher 会拉到不完整数据。  
  **→ Mitigation**：fetcher 内做严格类型守卫（`title` / `url` / `source` 必有，否则跳过该 item），异常落到 `console.error`；端到端失败时整张卡 `null` 跳过。

- **UA 黑名单升级**：若对方未来对 osmosis 的 UA 也黑名单，会全量 403。  
  **→ Mitigation**：UA 字符串通过 fetcher 内常量集中管理；切换字符串只需改一行；监控仍走现有 `failure / recovery alert` workflow。

- **「pre-baked notify body」被滥用**：未来 fetcher 写入未脱敏 / 超长正文，IM 卡片渲染异常。  
  **→ Mitigation**：spec 明确该字段为 markdown，限制最大长度（如 4 KB），超出则截断 + 省略号；测试覆盖。

- **行为兼容性**：`output.notify.summary === false` 在现有订阅未使用，本次扩展属于"激活新路径"而非改变旧行为。但 spec / 文档须显式说明现状下"不带 notify_body 的 summary:false 仍是静默"。

## Migration Plan

无数据迁移。部署即生效：
1. 合并代码 + 新 `aihot.yml`。
2. 下一次 hourly cron 自动尝试拉 AI HOT 日报；当日已过 08:00 BJT 应直接成功。
3. 回滚：删除 `subscriptions/aihot.yml` 即让该源完全失效（fetcher 文件保留无害）。

## Open Questions

无（用户已就 take=20 / mode=selected / 文件名格式 / 无 LLM 摘要四项拍板）。
