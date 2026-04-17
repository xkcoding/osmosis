import type { Notifier } from './types.js'
import { wecomNotifier } from './wecom.js'
import { feishuNotifier } from './feishu.js'

const registry = new Map<string, Notifier>()

export function register(notifier: Notifier): void {
  registry.set(notifier.channel, notifier)
}

export function getNotifier(channel: string): Notifier | undefined {
  return registry.get(channel)
}

export function listChannels(): string[] {
  return Array.from(registry.keys())
}

register(wecomNotifier)
register(feishuNotifier)
