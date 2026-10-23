/** Direct smoke test on a structured Markdown document (chunking + kept blocks) against a humanizer llama-server (HUMANIZER_BASE_URL). */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlamaServerClient } from '../src/client.ts'
import { humanize } from '../src/engine.ts'
import { renderReport } from '../src/index.ts'

const key = (): Promise<string | undefined> => {
  const m = /^\s+HUMANIZER_API_KEY:\s*(.+)$/m.exec(readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8'))
  return Promise.resolve(m?.[1]?.trim().replace(/^['"]|['"]$/g, ''))
}
const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/hz_text.json', import.meta.url), 'utf8'))
const doc: string = fx.plans.md.input
const client = new LlamaServerClient({ baseURL: (process.env.HUMANIZER_BASE_URL ?? 'http://127.0.0.1:8080'), apiKey: key, requestTimeoutMs: 600_000 })
const r = await humanize(doc, client, { signal: new AbortController().signal })
console.log(renderReport(r))
