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
}

const DEFAULT_MODEL = 'MiniMax-M2.7-highspeed'
const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1'

export async function summarize(
  source: SourceContent,
  promptTemplate: string,
  options: SummarizeOptions = {},
): Promise<string> {
  const modelId = options.model ?? process.env.SUMMARY_MODEL ?? DEFAULT_MODEL
  const baseURL = process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL
  const apiKey = process.env.MINIMAX_API_KEY ?? process.env.LLM_API_KEY
  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY (or LLM_API_KEY) env var is required for summarize')
  }

  const systemPrompt = promptTemplate
    .replaceAll('{{content}}', source.content.trim())
    .replaceAll('{{title}}', source.title)
    .replaceAll('{{name}}', source.name)

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
