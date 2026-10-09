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
  /** 跨运行状态（如分页水位），写入 frontmatter `sync_state`，下次运行经 FetchContext.getLastSyncState 读回 */
  syncState?: Record<string, string>
}

export interface FetchContext {
  /** 懒加载本源最新（按 title 日期）已同步 PR 的 frontmatter `sync_state`；缺失时返回 undefined */
  getLastSyncState?: () => Promise<Record<string, string> | undefined>
  /** 懒加载最近 n 个已同步 PR 的 markdown 内容（新→旧）；仅需要历史的 fetcher 调用 */
  getRecentSyncedContents?: (n: number) => Promise<string[]>
}

export interface Fetcher {
  readonly type: string
  fetch(config: SourceConfig, ctx?: FetchContext): Promise<FetchResult | null>
}
