export interface NotifyPayload {
  summary: string
  sources: string[]
  prUrls: string[]
  date: string
}

export interface Notifier {
  readonly channel: string
  send(payload: NotifyPayload): Promise<void>
}
