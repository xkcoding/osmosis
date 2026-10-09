## Purpose

为 fetcher 提供无数据库的跨运行状态通道：状态随同步产物写入下游 markdown frontmatter，下一次运行从最新已同步 PR 读回，保持「状态问 GitHub」的模型。

## ADDED Requirements

### Requirement: 同步状态写入 frontmatter

当 fetcher 返回的结果携带非空的同步状态（字符串键值对）时，系统 SHALL 将其原样写入生成 markdown 的 frontmatter `sync_state` 字段（YAML 映射）。结果不携带同步状态或其为空时，frontmatter MUST NOT 出现 `sync_state` 字段，以保证未使用该能力的源输出不变。

#### Scenario: 携带同步状态

- **WHEN** fetcher 返回结果携带同步状态 `{ cursor: "ax1.abc" }`
- **THEN** 生成的 markdown frontmatter 含 `sync_state: { cursor: "ax1.abc" }`，且其余 frontmatter 字段与正文不变

#### Scenario: 不携带同步状态

- **WHEN** fetcher 返回结果未携带同步状态（或为空映射）
- **THEN** 生成的 markdown frontmatter 不含 `sync_state` 字段

### Requirement: 从最新已同步 PR 读回同步状态

当配置了下游仓库时，系统 SHALL 向 fetcher 提供按需（懒加载）读取上一次同步状态的能力：选取本源 OPEN 或 MERGED 的已同步 PR 中 **title 日期最新** 的一个（与「最新已同步 PR」的既有排序规则一致，不按创建时间），解析其 markdown frontmatter 的 `sync_state` 并返回。

- 最新 PR 不存在、不含 `sync_state`、或 frontmatter 无法解析时，MUST 返回「无状态」而非抛异常。
- 读取过程中的 GitHub 访问错误 MAY 抛出，由 fetcher 自行决定降级方式。
- 未配置下游仓库（本地 smoke 运行）时，系统 MUST NOT 提供该能力，fetcher MUST 在无状态下仍可工作。
- 只有调用了该能力的 fetcher 才会触发 GitHub 读取。

#### Scenario: 最新 PR 含同步状态

- **WHEN** 本源最新（按 title 日期）已同步 PR 的 frontmatter 含 `sync_state: { cursor: "ax1.abc" }`
- **THEN** 读取返回 `{ cursor: "ax1.abc" }`

#### Scenario: 回填 PR 不抢占最新位置

- **WHEN** 存在一个创建时间更晚但 title 日期更早的回填 PR，且 title 日期最新的 PR 含 `sync_state`
- **THEN** 读取返回 title 日期最新 PR 的 `sync_state`

#### Scenario: 最新 PR 无同步状态

- **WHEN** 本源最新已同步 PR 的 frontmatter 不含 `sync_state`
- **THEN** 读取返回「无状态」，不抛异常

#### Scenario: 本地运行

- **WHEN** 未设置下游仓库运行 fetch
- **THEN** fetcher 收到的上下文中不提供同步状态读取能力，fetcher 正常产出结果

### Requirement: 回填运行不写入同步状态

当「今天」被固定为历史日期（回填运行）时，fetcher MUST NOT 在结果中携带同步状态，避免历史笔记承载与其日期无关的运行时水位。

#### Scenario: 回填运行

- **WHEN** 以固定历史日期运行一个使用同步状态的 fetcher
- **THEN** 生成的 markdown frontmatter 不含 `sync_state`
