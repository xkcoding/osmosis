# Tasks: osmosis initial-setup

## Phase 1: 项目脚手架

- [x] **T1.1** 初始化 TypeScript 项目（package.json, tsconfig.json, pnpm）
- [x] **T1.2** 配置 ESLint + 构建脚本（tsx 或 tsup）
- [x] **T1.3** 创建 README.md（项目说明、架构图、使用方式）

## Phase 2: 核心管道 — Fetch + Format

- [x] **T2.1** 实现 `src/config.ts` — 解析 subscriptions/*.yml
- [x] **T2.2** 定义 Fetcher 接口（`src/fetchers/types.ts`）+ registry
- [x] **T2.3** 实现 `github-file` fetcher（`src/fetchers/github-file.ts`）
  - 路径模板解析（`{year}`, `{date}`）
  - 通过 GitHub API 拉取文件内容
  - 无新内容时返回 null
- [x] **T2.4** 实现 `src/formatter.ts` — Obsidian frontmatter 格式化
- [x] **T2.5** 创建第一个订阅配置 `subscriptions/builderpulse.yml`
- [x] **T2.6** 实现 `src/index.ts` fetch 子命令 — 串联 config → fetch → format → 输出文件
- [x] **T2.7** 实现去重逻辑（`gh pr list` 检查同名同日 PR）

## Phase 3: GitHub Actions Workflow

- [x] **T3.1** 实现 `prepare` job — 扫描 subscriptions/ 生成 matrix
- [x] **T3.2** 实现 `sync` job — matrix 并行，调用 fetch + peter-evans/create-pull-request
- [x] **T3.3** 配置 Secrets（TARGET_REPO_PAT）
- [x] **T3.4** 端到端测试 — workflow_dispatch 手动触发，验证 PR 创建

## Phase 4: LLM 摘要

- [x] **T4.1** 实现 `src/summarizer.ts` — Vercel AI SDK + GitHub Models
- [x] **T4.2** 编写 `prompts/summary.md` — system prompt
- [x] **T4.3** 实现 `src/index.ts` summarize 子命令 — 收集当日新 PR 内容 → 生成摘要
- [x] **T4.4** 模型切换支持（环境变量 `SUMMARY_MODEL`）

## Phase 5: 通知推送

- [x] **T5.1** 定义 Notifier 接口（`src/notifiers/types.ts`）
- [x] **T5.2** 实现企微 notifier（`src/notifiers/wecom.ts`）
- [x] **T5.3** 实现飞书 notifier（`src/notifiers/feishu.ts`）
- [x] **T5.4** 实现 `src/index.ts` notify 子命令
- [x] **T5.5** 在 workflow 中接入 `notify` job
- [x] **T5.6** 配置 Secrets（FEISHU_WEBHOOK_URL 配了；WECOM_WEBHOOK_URL 暂未配，notifier 按设计静默跳过）

## Phase 6: Second-Brain 侧集成

osmosis 侧的职责是**输出一个稳定可编程的 PR 契约**，供下游仓库（second-brain）的 Claude Code hooks / 命令消费。这部分 osmosis 已交付。实际的 hook + PR review 命令实现属于 second-brain 仓库的范畴，在那边另起 opsx change 处理。

- [x] **T6.1** ~~在 second-brain 添加 Claude Code SessionStart hook~~ → osmosis 侧已输出 `contributing/pr-contract.md` 作为握手文档（四个 label 语义、安全/不安全操作、gh 查询 recipe）；hook 具体实现由 second-brain 侧 opsx change 完成
- [x] **T6.2** ~~编写 PR review 引导逻辑~~ → 同上，由 second-brain 侧实现，osmosis 只保证契约稳定

## Phase 7: 文档 + 上线

- [x] **T7.1** 完善 README（安装配置、添加新订阅源指南、架构说明）
- [x] **T7.2** 启用 cron schedule，正式上线
- [x] **T7.3** 验证完整流程：cron → fetch → PR → summary → notify
