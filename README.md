# osmosis

GitHub Actions 驱动的多源内容订阅聚合器。

监听 GitHub 文件 / Release / RSS 等多类信息源，自动同步到 Obsidian vault（via PR），并通过企微 / 飞书推送 LLM 摘要。

## 架构

```
cron (每小时)
  → prepare job: 读取 subscriptions/*.yml，生成 matrix
  → sync job (matrix, 并行): 每个源独立
      fetch → format → peter-evans/create-pull-request (独立 PR)
  → notify job: 收集当日新 PR → LLM 聚合摘要 → 企微 + 飞书
```

- **TypeScript** 负责 fetch / format / summarize / notify
- **GitHub Actions** 负责调度、并发、PR 创建
- **PR 粒度**：每源独立 PR，便于隔离与 review
- **去重**：依赖目标仓库的 PR label（`auto-sync` + `source:<name>`）+ 标题日期搜索
- **LLM**：默认 `anthropic/claude-sonnet-4`（GitHub Models），可通过 `SUMMARY_MODEL` 切换

## 目录结构

```
osmosis/
├── .github/workflows/daily-sync.yml   # 主 workflow（cron + matrix）
├── src/
│   ├── index.ts                        # CLI 入口（fetch / summarize / notify / matrix / list）
│   ├── config.ts                       # 解析 subscriptions/*.yml
│   ├── formatter.ts                    # Obsidian frontmatter 格式化
│   ├── summarizer.ts                   # Vercel AI SDK + GitHub Models
│   ├── dedup.ts                        # gh pr list 去重
│   ├── pr-listing.ts                   # 列出当日 sync PR + 拉取 PR 文件内容
│   ├── template.ts                     # {date}/{year}/{month}/{day} 模板替换
│   ├── fetchers/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   └── github-file.ts
│   └── notifiers/
│       ├── types.ts
│       ├── format.ts
│       ├── registry.ts
│       ├── wecom.ts
│       └── feishu.ts
├── subscriptions/
│   └── builderpulse.yml
├── prompts/
│   └── summary.md                      # LLM system prompt（可热改）
└── package.json
```

## 本地开发

```bash
pnpm install

# 列出所有订阅源 slug
pnpm tsx src/index.ts list

# 拉取单个源到指定目录
TARGET_REPO=xkcoding/second-brain GITHUB_TOKEN=ghp_xxx \
  pnpm fetch --subscription builderpulse --output-dir /tmp/vault

# 生成摘要
TARGET_REPO=xkcoding/second-brain GITHUB_TOKEN=ghp_xxx \
  pnpm summarize --target-repo xkcoding/second-brain --output summary.md

# 推送通知
WECOM_WEBHOOK_URL=... FEISHU_WEBHOOK_URL=... \
  pnpm notify --target-repo xkcoding/second-brain --summary-file summary.md
```

> `gh` CLI 必须本地可用，且已登录有 second-brain 仓库读取权限的账号。

## 配置 Secrets

在 GitHub Repo Settings → Secrets and variables → Actions：

| Secret | 用途 |
|--------|------|
| `TARGET_REPO_PAT` | PAT，权限 `repo`，用于 checkout second-brain + 创建 PR + 调用 GitHub Models |
| `WECOM_WEBHOOK_URL` | 企微机器人 webhook |
| `FEISHU_WEBHOOK_URL` | 飞书机器人 webhook |

可选 Repo Variables：

| Variable | 默认 |
|----------|------|
| `SUMMARY_MODEL` | `anthropic/claude-sonnet-4` |

## 添加新订阅源

1. 在 `subscriptions/` 创建 `<slug>.yml`：
   ```yaml
   name: <slug>
   source:
     type: github-file        # 或其他注册过的 fetcher 类型
     repo: owner/repo
     path: "path/{year}/{date}.md"
     branch: main
     title: 显示名
   output:
     obsidian:
       enabled: true
       path: "00_Inbox/Clippings/{date} - 显示名.md"
       frontmatter:
         type: reference
         tags: [clipping/<slug>]
     notify:
       enabled: true
       summary: true
       channels: [wecom, feishu]
   ```
2. 推到 main，下一个整点 cron 自动生效。

### 新增 Fetcher 类型

1. 实现 `src/fetchers/<type>.ts`，导出符合 `Fetcher` 接口的对象
2. 在 `src/fetchers/registry.ts` 中 `register(yourFetcher)`
3. 用新 `type` 写订阅 yaml

### 新增 Notifier 渠道

1. 实现 `src/notifiers/<channel>.ts`
2. 在 `src/notifiers/registry.ts` 注册
3. 在订阅 yaml 的 `output.notify.channels` 中引用

## 路径模板变量

| 变量 | 示例 |
|------|------|
| `{date}` | `2026-04-17` |
| `{year}` | `2026` |
| `{month}` | `04` |
| `{day}` | `17` |

时区默认 `Asia/Shanghai`，可通过 `OSMOSIS_TZ` 覆盖。
