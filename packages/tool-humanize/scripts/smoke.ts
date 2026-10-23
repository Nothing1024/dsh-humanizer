/**
 * Direct smoke test of the humanize_text tool against the real humanizer llama-server.
 * Runs the tool through a real cordis Context + ToolRegistry; the Bearer key is read from
 * ~/.dsh/.credentials.yaml refs (HUMANIZER_API_KEY) by a stub credentials service and never printed.
 * Usage: (cd packages/tool-humanize && ../../node_modules/.bin/tsx scripts/smoke.ts) [n_samples]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as tool from '../src/index.ts'

function credentialFromFile(ref: string): string | undefined {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const m = new RegExp(`^\\s+${ref}:\\s*(.+)$`, 'm').exec(text)
  return m?.[1]?.trim().replace(/^['"]|['"]$/g, '')
}

const ZH = '在当今快速发展的数字化时代，人工智能技术正以前所未有的速度深刻改变着我们的生活方式。值得注意的是，2026年全国共有48家门店完成了数字化改造，平均客服响应时间缩短至3分钟，客户满意度提升至95%。总而言之，这一成果离不开“星火计划”团队的共同努力，也为未来的发展奠定了坚实的基础。'
const EN = 'In today\'s rapidly evolving digital landscape, it is important to note that our team successfully shipped 3 major releases in Q2 2026. Furthermore, revenue grew by 12.5% to $1,250,000, while support response times dropped to 4 hours. Overall, this achievement underscores the dedication of the Project Aurora team and lays a solid foundation for future growth.'

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? '1')
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string): void }).provide('credentials')
  ctx.set('credentials', { resolve: async (ref: string) => { const v = credentialFromFile(ref); return v ? { value: v, source: 'file' } : undefined } } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(tool, { baseURL: (process.env.HUMANIZER_BASE_URL ?? 'http://127.0.0.1:8080'), apiKeyEnv: 'HUMANIZER_API_KEY' })
  for (const [label, text, keep] of [['zh', ZH, ['星火计划']], ['en', EN, ['Project Aurora']]] as const) {
    const t0 = Date.now()
    const r = await ctx.tools.execute({ callId: ToolCallId(`smoke-${label}`), name: 'humanize_text', arguments: { text, n_samples: n, keep: [...keep] }, signal: new AbortController().signal } as never)
    const out = (r as { content: Array<{ text?: string }>; isError: boolean })
    console.log(`===== ${label} (isError=${out.isError}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    console.log(out.content.map((b) => b.text ?? '').join('\n'))
  }
  await ctx.dispose?.()
}

main().catch((e) => { console.error(e); process.exit(1) })
