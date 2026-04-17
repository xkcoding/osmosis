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

const DEFAULT_MODEL = 'openai/gpt-5'
const DEFAULT_PROMPT_PATH = 'prompts/summary.md'

export async function summarize(
  sources: SourceContent[],
  options: SummarizeOptions = {},
): Promise<string> {
  if (sources.length === 0) {
    return ''
  }

  const modelId = options.model ?? process.env.SUMMARY_MODEL ?? DEFAULT_MODEL
  const promptPath = options.promptPath ?? DEFAULT_PROMPT_PATH
  const promptTemplate = readFileSync(promptPath, 'utf8')

  const sourcesBlock = sources
    .map((s) => `### ${s.title} (${s.name})\n\n${s.content.trim()}`)
    .join('\n\n---\n\n')

  const systemPrompt = promptTemplate
    .replaceAll('{{count}}', String(sources.length))
    .replaceAll('{{sources}}', sourcesBlock)

  const provider = createOpenAI({
    baseURL: 'https://models.github.ai/inference',
    apiKey: process.env.GITHUB_TOKEN,
  })

  const { text } = await generateText({
    model: provider(modelId),
    prompt: systemPrompt,
  })

  return text.trim()
}
