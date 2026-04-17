import { describe, it, expect } from 'vitest'
import { stripThinking } from './summarizer.js'

describe('stripThinking', () => {
  it('removes a single <think> block', () => {
    const out = stripThinking('<think>reasoning here</think>\n\nactual summary')
    expect(out).toBe('actual summary')
  })

  it('removes <thinking> variant', () => {
    expect(stripThinking('<thinking>x</thinking>body')).toBe('body')
  })

  it('removes multiline reasoning', () => {
    const input = '<think>\nmulti\nline\nreasoning\n</think>\n\n# Summary\n\nbody'
    expect(stripThinking(input)).toBe('# Summary\n\nbody')
  })

  it('removes multiple blocks', () => {
    const input = '<think>a</think>first <think>b</think>second'
    expect(stripThinking(input)).toBe('first second')
  })

  it('is case-insensitive', () => {
    expect(stripThinking('<THINK>x</THINK>body')).toBe('body')
  })

  it('leaves content without think tags unchanged', () => {
    expect(stripThinking('# Title\n\nbody')).toBe('# Title\n\nbody')
  })

  it('does not touch the literal word "think" outside tags', () => {
    expect(stripThinking('I think this is fine')).toBe('I think this is fine')
  })
})
