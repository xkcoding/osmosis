export interface NotifyPayload {
  summary: string
  sources: string[]
  prUrls: string[]
  date: string
}

export type NotifyResult = 'sent' | 'skipped'

export interface Notifier {
  readonly channel: string
  send(payload: NotifyPayload): Promise<NotifyResult>
}
