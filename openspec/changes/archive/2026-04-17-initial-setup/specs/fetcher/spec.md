# Spec: Fetcher 插件系统

## 概述

Fetcher 是 osmosis 的内容获取插件。每种数据源类型对应一个 Fetcher 实现，通过统一接口接入主管道。

## 接口契约

```typescript
interface SourceConfig {
  type: string                    // fetcher 类型标识
  [key: string]: unknown          // 各类型自有配置
}

interface FetchResult {
  title: string                   // 内容标题
  date: string                    // YYYY-MM-DD
  content: string                 // Markdown 全文
  sourceUrl: string               // 来源 URL
}

interface Fetcher {
  readonly type: string
  fetch(config: SourceConfig): Promise<FetchResult | null>
}
```

- 返回 `null` 表示今天无新内容（或已同步过）
- 抛异常表示获取失败（由调度层捕获并记录）

## 已规划的 Fetcher 类型

| type | 说明 | 配置字段 | 优先级 |
|------|------|----------|--------|
| `github-file` | 拉取仓库中指定路径的文件 | `repo`, `path`, `branch` | P0 (首期) |
| `github-release` | 监听仓库新 Release | `repo`, `include_prerelease` | P1 |
| `github-commits` | 汇总 commit 信息 | `repo`, `branch`, `since` | P2 |
| `rss` | 通用 RSS/Atom feed | `feed_url`, `item_count` | P1 |

## github-file 配置详情

```yaml
source:
  type: github-file
  repo: BuilderPulse/BuilderPulse    # owner/repo
  path: "zh/{year}/{date}.md"        # 路径模板
  branch: main                       # 可选，默认 main
```

### 路径模板变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `{date}` | 当天日期 YYYY-MM-DD | 2026-04-17 |
| `{year}` | 当天年份 YYYY | 2026 |
| `{month}` | 当月 MM | 04 |
| `{day}` | 当日 DD | 17 |

## 注册机制

```typescript
// src/fetchers/registry.ts

const registry = new Map<string, Fetcher>()

function register(fetcher: Fetcher): void
function getFetcher(type: string): Fetcher
```

新增 Fetcher 步骤：
1. 在 `src/fetchers/` 下创建实现文件
2. 在 `registry.ts` 中注册
3. 在 `subscriptions/` 下创建对应的 `.yml` 配置
