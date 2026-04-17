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
