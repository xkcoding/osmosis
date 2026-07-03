export interface SourceConfig {
  type: string
  [key: string]: unknown
}

export interface FetchResult {
  title: string
  date: string
  content: string
  sourceUrl: string
  notifyBody?: string
}

export interface FetchContext {
  /** 本源最近一个已同步 PR 的 createdAt（ISO datetime）；无历史 PR 时缺省 */
  lastSyncedAt?: string
  /** 懒加载最近 n 个已同步 PR 的 markdown 内容（新→旧）；仅需要历史的 fetcher 调用 */
  getRecentSyncedContents?: (n: number) => Promise<string[]>
}

export interface Fetcher {
  readonly type: string
  fetch(config: SourceConfig, ctx?: FetchContext): Promise<FetchResult | null>
}
