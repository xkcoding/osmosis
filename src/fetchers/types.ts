export interface SourceConfig {
  type: string
  [key: string]: unknown
}

export interface FetchResult {
  title: string
  date: string
  content: string
  sourceUrl: string
}

export interface Fetcher {
  readonly type: string
  fetch(config: SourceConfig): Promise<FetchResult | null>
}
