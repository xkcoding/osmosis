# Proposal: osmosis — 多源内容订阅聚合器

## 问题

日常关注的高质量信息源（如 BuilderPulse）每天更新，但缺少自动化管道将内容同步到个人知识库（Obsidian vault）并推送摘要通知。手动剪藏效率低，且容易遗漏。

## 方案

构建一个 GitHub Actions 驱动的订阅聚合器：

1. **定时监听**：每小时通过 cron 检查各订阅源是否有新内容
2. **全文落盘**：将新内容格式化为 Obsidian Markdown，以独立 PR 提交到 second-brain 仓库
3. **LLM 摘要**：使用 Claude / Gemini（GitHub Models）生成跨源聚合摘要
4. **多渠道推送**：将摘要推送到企微机器人和飞书机器人

## 架构概览

```
cron (每小时)
  → prepare job: 读取 subscriptions/*.yml，生成 matrix
  → sync job (matrix, 并行): 每个源独立
      fetch → format → peter-evans/create-pull-request (独立 PR)
  → notify job: 收集新 PR → LLM 聚合摘要 → 企微 + 飞书
```

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript | 类型安全，AI SDK 生态好 |
| PR 创建 | peter-evans/create-pull-request | Action 原生能力，不重复造轮子 |
| PR 粒度 | 每源独立 PR | 隔离性好，review 灵活 |
| 去重 | PR label + title 搜索 | 轻量，无需额外状态存储 |
| LLM | GitHub Models (Claude/Gemini) | GitHub Pro 免费额度，零额外 key |
| 触发频率 | 每小时 | 平衡及时性与 Action 额度 |
| Fetcher | 插件化接口 | 新增源不动 workflow |
| 仓库可见性 | 公开 | 社区可参考复用 |

## 非目标

- 不做实时推送（webhook 触发），cron 轮询足够
- 不做内容翻译，各源按原语言同步
- 不做 PR 自动合并，留给 Claude Code hook 人工引导
- 第一期不做 RSS fetcher，先跑通 github-file

## 涉及仓库

- `xkcoding/osmosis`（本仓库）：Action workflow + TypeScript 代码
- `xkcoding/second-brain`（私有）：PR 目标仓库，需 PAT 授权

## 首个订阅源

BuilderPulse Daily（中文版）
- 源：`BuilderPulse/BuilderPulse` → `zh/{year}/{date}.md`
- 输出：`00_Inbox/Clippings/{date} - BuilderPulse Daily.md`
- 频率：每天一篇，约上午 10:30 (UTC+8)
