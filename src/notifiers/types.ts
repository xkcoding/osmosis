export interface SourceInfo {
  name: string
  title: string
}

export interface NotifyPayload {
  summary: string
  sources: SourceInfo[]
  prUrls: string[]
  date: string
}

export type NotifyResult = 'sent' | 'skipped'

export interface Notifier {
  readonly channel: string
  send(payload: NotifyPayload): Promise<NotifyResult>
}
