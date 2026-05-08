# Spec: Notifier 通知系统

## 概述

Notifier 负责将 LLM 生成的摘要推送到外部 IM 渠道。支持多渠道并行推送。

## 接口契约

```typescript
interface NotifyPayload {
  summary: string             // LLM 生成的摘要文本
  sources: string[]           // 本次涉及的源名称列表
  prUrls: string[]            // 对应的 PR URL 列表
  date: string                // YYYY-MM-DD
}

interface Notifier {
  readonly channel: string
  send(payload: NotifyPayload): Promise<void>
}
```

## 支持的渠道

### 企微机器人 (wecom)

- Webhook URL 通过 `WECOM_WEBHOOK_URL` secret 传入
- 消息类型：`markdown`
- 限制：单条消息 <= 4096 字节

### 飞书机器人 (feishu)

- Webhook URL 通过 `FEISHU_WEBHOOK_URL` secret 传入
- 消息类型：`interactive`（富文本卡片）
- 限制：单条消息 <= 30KB

## 消息模板

```
📡 每日情报摘要 — {date}

{summary}

📎 全文 PR：
{prList}

---
osmosis · 来源: {sourceNames}
```

## 容错

- 单个渠道推送失败不影响其他渠道
- 失败时记录错误日志但不阻断 workflow
- Webhook URL 未配置的渠道自动跳过（不报错）

## Requirements

### Requirement: pre-baked notify body 路径

当订阅配置 `output.notify.summary === false` 时，summarize 阶段 SHALL 检查同步到 PR 的 markdown 文件 frontmatter 是否含 `notify_body` 字段：

- 若含 `notify_body`：SHALL 使用该字段值作为 `summary-sections.json` 中该源的 `summary` 文本，跳过 LLM 调用，但仍把该 section 加入数组，使 notify 阶段正常推送 IM 卡。
- 若不含 `notify_body`：SHALL 维持现有行为（跳过该源，不入 `summary-sections.json`），保留向后兼容的「完全静默」语义。

当订阅配置 `output.notify.summary === true`（或缺省）时，summarize 阶段 SHALL 忽略 `notify_body` frontmatter，照常调用 LLM 生成摘要。

#### Scenario: summary:false + 含 notify_body

- **WHEN** 订阅 yaml 设置 `output.notify.summary: false`，且 PR 同步的 markdown frontmatter 含 `notify_body: "..."`
- **THEN** summarize 阶段不调用 LLM，但 `summary-sections.json` 内含该源条目，其 `summary` 字段值等于 `notify_body` 字段值；notify 阶段正常推送 IM 卡

#### Scenario: summary:false + 无 notify_body

- **WHEN** 订阅 yaml 设置 `output.notify.summary: false`，且 markdown frontmatter 不含 `notify_body`
- **THEN** summarize 阶段跳过该源，`summary-sections.json` 中无该源条目，notify 阶段不推送

#### Scenario: summary:true 时忽略 notify_body

- **WHEN** 订阅 yaml 设置 `output.notify.summary: true`（或省略 summary 字段），且 markdown frontmatter 含 `notify_body`
- **THEN** summarize 阶段照常调用 LLM；`summary-sections.json` 中该源的 `summary` 字段值为 LLM 输出而非 `notify_body`

### Requirement: notify_body frontmatter 持久化

formatter（`formatForObsidian`）SHALL 在 `FetchResult.notifyBody` 字段非空时，将其写入输出 markdown 的 frontmatter `notify_body` 键，使用 YAML 多行块字符串语法（`|`）。`FetchResult.notifyBody` 为空或 `undefined` 时 MUST NOT 写入该字段。

#### Scenario: fetcher 提供 notifyBody

- **WHEN** fetcher 返回的 `FetchResult.notifyBody` 是非空字符串
- **THEN** `formatForObsidian` 输出的 markdown frontmatter 含 `notify_body: |` 多行块，其内容等于 `FetchResult.notifyBody`

#### Scenario: fetcher 未提供 notifyBody

- **WHEN** fetcher 返回的 `FetchResult` 不含 `notifyBody`（或为 `undefined` / 空字符串）
- **THEN** 输出 markdown frontmatter 不含 `notify_body` 键
