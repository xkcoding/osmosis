import { readFileSync } from 'node:fs'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

export interface SourceContent {
  name: string
  title: string
  content: string
  prUrl?: string
}

export interface SummarizeOptions {
  model?: string
  promptPath?: string
}

const DEFAULT_MODEL = 'MiniMax-M2.7-highspeed'
const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1'
const DEFAULT_PROMPT_PATH = 'prompts/summary.md'

export async function summarize(
  sources: SourceContent[],
  options: SummarizeOptions = {},
): Promise<string> {
  if (sources.length === 0) {
    return ''
  }

  const modelId = options.model ?? process.env.SUMMARY_MODEL ?? DEFAULT_MODEL
  const baseURL = process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL
  const apiKey = process.env.MINIMAX_API_KEY ?? process.env.LLM_API_KEY
  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY (or LLM_API_KEY) env var is required for summarize')
  }

  const promptPath = options.promptPath ?? DEFAULT_PROMPT_PATH
  const promptTemplate = readFileSync(promptPath, 'utf8')

  const sourcesBlock = sources
    .map((s) => `### ${s.title} (${s.name})\n\n${s.content.trim()}`)
    .join('\n\n---\n\n')

  const systemPrompt = promptTemplate
    .replaceAll('{{count}}', String(sources.length))
    .replaceAll('{{sources}}', sourcesBlock)

  const provider = createOpenAI({ baseURL, apiKey })

  const { text } = await generateText({
    model: provider(modelId),
    prompt: systemPrompt,
  })

  return stripThinking(text).trim()
}

export function stripThinking(s: string): string {
  return s.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>\s*/gi, '')
}
