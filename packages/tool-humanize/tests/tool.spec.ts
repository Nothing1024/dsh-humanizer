import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as toolHumanize from '../src/index.ts'
import type { CompletionResult, HumanizerBackend } from '../src/client.ts'

const EN = 'Our team shipped 3 releases in 2026 and support response times dropped to 4 hours across all regions.'
const GOOD_EN = 'Three releases went out in 2026. Support now answers within 4 hours, everywhere.'

class Fake implements HumanizerBackend {
  readonly label = 'fake'
  calls = 0
  async tokenize(): Promise<number> { return 30 }
  async complete(): Promise<CompletionResult> { this.calls++; return { text: GOOD_EN, truncated: false, tokensPredicted: 20, ms: 1 } }
}

async function setup(config: Record<string, unknown> = {}, secret?: string): Promise<{ ctx: Context; fake: Fake; seenKey: () => Promise<string | undefined>; restore: () => void; seenBase: string[] }> {
  const ctx = new Context()
  if (secret !== undefined) {
    ;(ctx as unknown as { provide(name: string): void }).provide('credentials')
    ctx.set('credentials', {
      resolve: async (ref: string) => (ref === 'HUMANIZER_TEST_API_KEY' ? { value: secret, source: 'file' } : undefined),
    } as never)
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  const fake = new Fake()
  let seenKey: () => Promise<string | undefined> = async () => undefined
  const seenBase: string[] = []
  const restore = toolHumanize.setBackendFactory((cfg, apiKey) => { seenKey = apiKey; seenBase.push(cfg.baseURL); return fake })
  await ctx.plugin(toolHumanize, config)
  return { ctx, fake, seenKey: () => seenKey(), restore, seenBase }
}

async function call(ctx: Context, args: Record<string, unknown>, name = 'humanize_text'): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: ToolCallId('c1'),
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as never)
}

function textOf(r: ToolExecutionResult): string {
  return (r as { content: Array<{ type: string; text?: string }> }).content.map((b) => b.text ?? '').join('\n')
}

describe('humanize_text tool', () => {
  it('registers with the documented schema and usage guidance', async () => {
    const { ctx, restore } = await setup({ baseURL: 'http://llm.example:18080/v1', apiKeyEnv: 'HUMANIZER_TEST_API_KEY' })
    try {
      const schema = ctx.tools.schemas().find((s: { name: string }) => s.name === 'humanize_text') as unknown as { description: string; parameters: { properties: Record<string, unknown>; required?: string[] } }
      expect(schema).toBeDefined()
      expect(schema.description).toContain('去AI味')
      expect(Object.keys(schema.parameters.properties).sort()).toEqual(['keep', 'n_samples', 'text'])
      expect(schema.parameters.required).toEqual(['text'])
    } finally { restore() }
  })

  it('executes, renders the rewrite + report, and resolves the key by reference', async () => {
    const { ctx, fake, seenKey, restore, seenBase } = await setup({ baseURL: 'http://llm.example:18080', apiKeyEnv: 'HUMANIZER_TEST_API_KEY' }, 'sk-test-secret')
    try {
      const r = await call(ctx, { text: EN })
      expect((r as { isError: boolean }).isError).toBe(false)
      const text = textOf(r)
      expect(text).toContain(`<rewritten>\n${GOOD_EN}\n</rewritten>`)
      expect(text).not.toContain('sk-test-secret')
      expect(fake.calls).toBe(1)
      expect(seenBase).toEqual(['http://llm.example:18080'])
      expect(await seenKey()).toBe('sk-test-secret')
    } finally { restore() }
  })

  it('rejects text over maxChars', async () => {
    const { ctx, restore } = await setup({ maxChars: 10 })
    try {
      const r = await call(ctx, { text: EN })
      expect((r as { isError: boolean }).isError).toBe(true)
      expect(textOf(r)).toContain('above the configured limit of 10')
    } finally { restore() }
  })

  it('presents a diff card original → rewrite', () => {
    const view = toolHumanize.presentHumanizeResult({ text: EN }, { content: [{ type: 'text', text: `x\n<rewritten>\n${GOOD_EN}\n</rewritten>\n提醒：\n- a` }], isError: false } as never)
    expect(view).toEqual({ card: 'diff', title: '去 AI 味改写完成 · 1 条提醒', diffs: [{ path: '去AI味.md', oldText: EN, newText: GOOD_EN }] })
    const viaMeta = toolHumanize.presentHumanizeResult({ text: EN }, { content: [], isError: false, meta: { text: GOOD_EN, warnings: [] } } as never)
    expect(viaMeta).toMatchObject({ card: 'diff', title: '去 AI 味改写完成' })
    expect(toolHumanize.presentHumanizeResult({ text: EN }, { content: [], isError: true } as never)).toEqual({ card: 'generic' })
    expect(toolHumanize.presentHumanizeCall({ text: EN, n_samples: 2 })).toMatchObject({ card: 'generic', title: '去 AI 味改写（101 字符 · 2 个候选）' })
  })
})
