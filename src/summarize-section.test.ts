import { describe, it, expect, vi } from 'vitest'
import { buildSection } from './summarize-section.js'

const baseInput = {
  sourceName: 'aihot',
  displayTitle: 'AI HOT 日报',
  prUrl: 'https://github.com/x/y/pull/42',
}

const mdWithNotifyBody = `---
title: AI HOT — 2026-05-08
notify_body: |
  > today's lead

  ## 模型发布/更新
  - thing
---

# body
`

const mdWithoutNotifyBody = `---
title: AI HOT — 2026-05-08
---

# body
`

describe('buildSection', () => {
  it('summary disabled + notify_body present → section with body, LLM not called', async () => {
    const llm = vi.fn(async () => 'should-not-run')
    const section = await buildSection({
      ...baseInput,
      notifySummaryDisabled: true,
      prMarkdown: mdWithNotifyBody,
      llmSummarize: llm,
    })
    expect(llm).not.toHaveBeenCalled()
    expect(section).not.toBeNull()
    expect(section!.sourceName).toBe('aihot')
    expect(section!.summary).toContain("today's lead")
    expect(section!.summary).toContain('模型发布/更新')
    expect(section!.prUrl).toBe(baseInput.prUrl)
  })

  it('summary disabled + no notify_body → null, LLM not called', async () => {
    const llm = vi.fn(async () => 'should-not-run')
    const section = await buildSection({
      ...baseInput,
      notifySummaryDisabled: true,
      prMarkdown: mdWithoutNotifyBody,
      llmSummarize: llm,
    })
    expect(llm).not.toHaveBeenCalled()
    expect(section).toBeNull()
  })

  it('summary enabled + notify_body present → uses LLM, ignores notify_body', async () => {
    const llm = vi.fn(async () => 'llm-output')
    const section = await buildSection({
      ...baseInput,
      notifySummaryDisabled: false,
      prMarkdown: mdWithNotifyBody,
      llmSummarize: llm,
    })
    expect(llm).toHaveBeenCalledOnce()
    expect(section).not.toBeNull()
    expect(section!.summary).toBe('llm-output')
  })

  it('summary enabled + LLM returns empty → null', async () => {
    const llm = vi.fn(async () => '')
    const section = await buildSection({
      ...baseInput,
      notifySummaryDisabled: false,
      prMarkdown: mdWithoutNotifyBody,
      llmSummarize: llm,
    })
    expect(section).toBeNull()
  })

  it('malformed frontmatter → safe fallback to null when summary disabled', async () => {
    const llm = vi.fn(async () => 'x')
    const section = await buildSection({
      ...baseInput,
      notifySummaryDisabled: true,
      prMarkdown: '---\nnot: [valid: yaml\n---\n\nbody',
      llmSummarize: llm,
    })
    expect(section).toBeNull()
    expect(llm).not.toHaveBeenCalled()
  })
})
