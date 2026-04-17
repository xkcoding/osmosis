# Design: osmosis

## 项目结构

```
osmosis/
├── .github/
│   └── workflows/
│       └── daily-sync.yml              ← 主 workflow
│
├── src/
│   ├── index.ts                        ← CLI 入口（fetch / summarize / notify）
│   ├── config.ts                       ← 解析 subscriptions/*.yml
│   │
│   ├── fetchers/
│   │   ├── types.ts                    ← Fetcher 接口
│   │   ├── registry.ts                 ← type → fetcher 映射
│   │   └── github-file.ts              ← 第一个 fetcher 实现
│   │
│   ├── formatter.ts                    ← Obsidian frontmatter 格式化
│   │
│   ├── summarizer.ts                   ← LLM 摘要（Vercel AI SDK）
│   │
│   └── notifiers/
│       ├── types.ts                    ← Notifier 接口
│       ├── wecom.ts                    ← 企微 webhook
│       └── feishu.ts                   ← 飞书 webhook
│
├── subscriptions/
│   └── builderpulse.yml                ← 第一个订阅配置
│
├── prompts/
│   └── summary.md                      ← LLM system prompt（可热改）
│
├── package.json
├── tsconfig.json
└── README.md
```

## Workflow 设计

```yaml
# .github/workflows/daily-sync.yml

name: Daily Sync
on:
  schedule:
    - cron: '0 * * * *'       # 每小时整点
  workflow_dispatch:            # 手动触发（调试用）

jobs:
  prepare:
    # 读取 subscriptions/ 目录，输出 matrix JSON
    outputs:
      matrix: ${{ steps.scan.outputs.matrix }}

  sync:
    needs: prepare
    strategy:
      matrix: ${{ fromJson(needs.prepare.outputs.matrix) }}
      fail-fast: false          # 一个源失败不影响其他
    steps:
      - checkout osmosis repo
      - checkout second-brain repo (PAT)
      - setup node + pnpm
      - pnpm run fetch --subscription ${{ matrix.name }}
        # 输出文件到 second-brain checkout 目录
        # exit code 1 = 无新内容，后续 step 跳过
      - peter-evans/create-pull-request
          path: second-brain
          branch: auto-sync/${{ matrix.name }}-${{ env.DATE }}
          title: "📡 ${{ matrix.name }} ${{ env.DATE }}"
          labels: auto-sync, source:${{ matrix.name }}, needs-review
          commit-message: "sync: ${{ matrix.name }} ${{ env.DATE }}"

  notify:
    needs: sync
    if: always()                # 即使部分 sync 失败也执行
    steps:
      - checkout osmosis repo
      - setup node + pnpm
      - pnpm run summarize      # 收集今天新建的 PR → LLM 摘要
      - pnpm run notify          # 推送到企微 + 飞书
```

## 核心接口

### Fetcher

```typescript
// src/fetchers/types.ts

interface FetchResult {
  title: string           // 如 "BuilderPulse Daily"
  date: string            // "2026-04-17"
  content: string         // 原始 markdown 全文
  sourceUrl: string       // 来源 URL
}

interface Fetcher {
  type: string
  fetch(config: SourceConfig): Promise<FetchResult | null>
  // null = 今天无新内容（或已同步过）
}
```

### Subscription Config

```yaml
# subscriptions/builderpulse.yml

name: BuilderPulse Daily
source:
  type: github-file
  repo: BuilderPulse/BuilderPulse
  path: "zh/{year}/{date}.md"       # strftime 风格模板
  branch: main

output:
  obsidian:
    enabled: true
    path: "00_Inbox/Clippings/{date} - BuilderPulse Daily.md"
    frontmatter:
      type: reference
      source: "https://github.com/BuilderPulse/BuilderPulse"
      tags:
        - clipping/builderpulse
        - AI
        - indie-hacker

  notify:
    enabled: true
    summary: true
    channels:
      - wecom
      - feishu
```

### Formatter

```typescript
// src/formatter.ts

interface FormatOptions {
  frontmatter: Record<string, unknown>
  outputPath: string        // 模板化后的路径
}

function formatForObsidian(result: FetchResult, options: FormatOptions): string
// 输出: frontmatter + 原文 + 来源链接
```

输出示例：

```markdown
---
title: BuilderPulse Daily — 2026-04-17
type: reference
source: https://github.com/BuilderPulse/BuilderPulse
date_saved: 2026-04-17
tags:
  - clipping/builderpulse
  - AI
  - indie-hacker
---

{原文内容}

---

> [!info] 来源
> 自动同步自 [BuilderPulse/BuilderPulse](https://github.com/BuilderPulse/BuilderPulse) — zh/2026/2026-04-17.md
```

### Summarizer

```typescript
// src/summarizer.ts

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

const githubModels = createOpenAI({
  baseURL: 'https://models.github.ai/inference',
  apiKey: process.env.GITHUB_TOKEN,
})

async function summarize(results: FetchResult[]): Promise<string>
// 读取 prompts/summary.md 作为 system prompt
// 将所有源内容拼接后发送
// 返回 markdown 格式摘要
```

模型选择策略：
- 默认：`anthropic/claude-sonnet-4` (GitHub Models)
- 可通过环境变量切换：`SUMMARY_MODEL=google/gemini-2.5-flash`

### Notifier

```typescript
// src/notifiers/types.ts

interface NotifyPayload {
  summary: string           // LLM 生成的摘要
  sources: string[]         // 涉及的源名称
  prUrls: string[]          // 对应的 PR URL
  date: string
}

interface Notifier {
  channel: string
  send(payload: NotifyPayload): Promise<void>
}
```

企微/飞书消息格式：

```
📡 每日情报摘要 — 2026-04-17

{LLM 生成的 3-5 条信号}

📎 全文 PR：
  - BuilderPulse Daily → xkcoding/second-brain#42

---
osmosis · 来源: BuilderPulse Daily
```

## LLM Prompt 设计

```markdown
<!-- prompts/summary.md -->

你是一个每日情报分析师。

## 任务

从以下 {{count}} 个信息源的今日内容中，提炼出最值得关注的 3-5 条信号。

## 要求

- 每条信号一句话概括 + 一句话说明"为什么值得关注"
- 如果多个源提到同一趋势，合并并标注交叉验证
- 输出简洁，适合在 IM 消息中快速扫读
- 不要使用 emoji 堆砌，保持专业克制

## 信息源内容

{{sources}}
```

## 去重策略

fetch 阶段：
```typescript
// 检查目标仓库是否已有同名同日的 PR
const existing = await $`gh pr list \
  --repo ${targetRepo} \
  --label "auto-sync" \
  --label "source:${name}" \
  --search "${date}" \
  --state open --state merged \
  --json number`

if (JSON.parse(existing).length > 0) return null
```

## Secrets 配置

| Secret | 用途 | 来源 |
|--------|------|------|
| `TARGET_REPO_PAT` | 向 second-brain 提 PR | GitHub PAT (repo scope) |
| `WECOM_WEBHOOK_URL` | 企微机器人 | 企微群设置 |
| `FEISHU_WEBHOOK_URL` | 飞书机器人 | 飞书群设置 |
| `GITHUB_TOKEN` | GitHub Models API + gh CLI | Action 自带 |

## Second-Brain 侧 Hook

Claude Code SessionStart hook 检查逻辑（记录在此，实现在 second-brain 仓库）：

```bash
# 检查是否有待处理的 auto-sync PR
gh pr list --repo xkcoding/second-brain --label "auto-sync,needs-review" --json number,title
```

输出提示：
```
📬 你有 N 个订阅同步 PR 待处理：
  - #42 📡 BuilderPulse Daily 2026-04-17
要现在 review 吗？
```
