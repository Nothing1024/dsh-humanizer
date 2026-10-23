/**
 * The model-facing `humanize_text` tool: rewrite a draft so it reads like a person wrote it
 * (去AI味) with the dedicated humanizer model served by llama-server, instead of letting the main
 * model paraphrase it. The rewrite logic is a port of the official app / `hz` from
 * sgaofen/humanizer-local-model (Apache-2.0, see NOTICE): exact prompt (fingerprint
 * cc51d66b4c593fbe), evaluated sampling, Markdown-preserving chunking, keep-verbatim placeholders,
 * number/link/copy/language checks with automatic resampling, and 1–4 candidates per piece.
 *
 * The API key is a credential *reference* (`apiKeyEnv`, an environment-variable name resolved
 * through `ctx.credentials` per call, exactly like provider `apiKeyEnv`); the value never enters
 * config, logs or tool output.
 * @module dsh-tool-humanize
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
// Declaration merge only: makes ctx.systemPrompt visible for the section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LlamaServerClient, retryDelays } from './client.ts'
import type { HumanizerBackend, ProbeResult } from './client.ts'
import { literalKey, readSettings, samplingDeviations } from './settings.ts'
import type { Settings } from './settings.ts'
import { clampSamples, humanize } from './engine.ts'
import type { HumanizeResult } from './engine.ts'
import { FINGERPRINT, promptFingerprint } from './prompt.ts'
import type { Config } from './settings.ts'
import { HumanizerWeb, ROUTE_PREFIX } from './web.ts'
import type { WebSettings } from './web.ts'

export { HumanizerWeb, ROUTE_PREFIX } from './web.ts'
export type { WebDeps, WebLimits, WebSettings, WirePiece, WireCandidate } from './web.ts'
export { assembleDocument, planDocument, rewriteUnit } from './engine.ts'

export const name = 'tool-humanize'
export const inject = ['tools', 'systemPrompt']

export { Config, DEFAULTS, readSettings, samplingDeviations } from './settings.ts'
export type { Sampling as SamplingConfig, Settings } from './settings.ts'
export { FIELDS, SECTIONS, ENTRY_ID, OFFICIAL_KEYS } from './settings-meta.ts'

/** One operation's settings snapshot plus the literal key (host only, never served). */
type ResolvedConfig = Settings & { apiKey?: string }

export const DESCRIPTION = `Rewrite a draft so it reads like a person wrote it — 去AI味 / 降AI味 / humanize / "make this sound less like ChatGPT" — using the dedicated humanizer model (a fine-tuned 12B rewriter for English and Chinese running on a llama-server). Call this whenever the user asks to remove the AI flavor of a text, make it sound human/natural, or lower AI-detector signals. Do NOT paraphrase the draft yourself first and do not rewrite it again afterwards.

Pass the user's draft verbatim in \`text\` (plain text or Markdown; any length up to the configured limit). Long documents are cut like the official \`hz\` tool: headings, code, tables, quotes, link-only lines and references are kept as is; prose is rewritten in pieces of ~350 English words / ~600 Chinese characters; list bullets and **Label:** lead-ins are kept. Put exact substrings that must not change (names, product terms, quotations, slogans the user wants frozen) in \`keep\` — they are locked with placeholders and restored verbatim. Do not put plain numbers, dates or percentages in \`keep\`: the model preserves them and they are checked automatically; locking them only makes the rewrite stiffer. When the user wants several versions/alternatives, set \`n_samples\` (2–4) in ONE call: the best version by the checks is returned in <rewritten> and the others as <candidate>. Never call the tool again on your own reworded draft or on a previous output to get "another version".

Every piece is checked: numbers and links missing from the rewrite, numbers that were added, copying >50% of the draft, empty/cut-off/much shorter or longer output, repetition, stray HTML, and output in the wrong language (silently resampled up to 3×). A failing piece is sampled once more and the better version kept. The rewrite is a single sampling run, so it is slow: roughly 10–40 s per piece per sample.

After the call: give the user the text inside <rewritten> exactly as returned (you may translate nothing, fix nothing, and must not merge in your own edits). Relay every warning and ask the user to proofread numbers, names, dates and the direction of each claim. Never promise the result passes an AI detector.`

const RENDER_NOTE = '请把 <rewritten> 里的文本原样交给用户（不要再自行润色或"修正"事实）；如有提醒，逐条转告用户并请其核对数字、人名、日期与论断方向。'

function fmtSeconds(s: number): string {
  return `${s.toFixed(1)} s`
}

/** The model-facing text: the rewrite, alternatives, warnings, and a compact per-piece report. */
export function renderReport(r: HumanizeResult): string {
  const lines: string[] = []
  const pieces = r.pieces.length
  lines.push(`humanize_text：${pieces} 段 · 每段 ${r.nSamples} 个候选 · ${r.requests} 次模型请求 · ${fmtSeconds(r.seconds)}`)
  lines.push('<rewritten>')
  lines.push(r.text)
  lines.push('</rewritten>')
  const same = r.variants.indexOf(r.text)
  if (same >= 0) lines.push(`（<rewritten> 即候选 ${same + 1}：各段按检查得分取最优）`)
  r.variants.forEach((v, i) => {
    if (v === r.text) return
    lines.push(`<candidate n="${i + 1}">`)
    lines.push(v)
    lines.push('</candidate>')
  })
  if (r.warnings.length > 0) {
    lines.push('提醒：')
    for (const w of r.warnings) lines.push(`- ${w}`)
  } else if (pieces > 0) {
    lines.push('检查：数字、链接、照抄率、长度、语言均未发现问题（检查不覆盖措辞/人名/论断是否被改，仍需人工过目）。')
  }
  if (pieces > 1) {
    lines.push('分段：')
    for (const p of r.pieces) {
      const c = p.candidates[p.chosen]!
      lines.push(`- 第 ${p.id} 段（第 ${p.line} 行，${p.words} 字/词）：照抄率 ${c.copyRate.toFixed(2)}，采样 ${p.candidates.length} 次，用第 ${p.chosen + 1} 个，${fmtSeconds(p.seconds)}`)
    }
  }
  const keptKinds = Object.entries(r.kept).filter(([, n]) => n > 0)
  if (keptKinds.length > 0) lines.push(`原样保留：${keptKinds.map(([k, n]) => `${k}×${n}`).join('，')}`)
  if (r.keepActive.length > 0) lines.push(`锁定原文：${r.keepActive.map((k) => `「${k}」`).join('、')}`)
  lines.push(RENDER_NOTE)
  return lines.join('\n')
}

/** Structured report kept for presenters (no secrets; the draft itself is in the call args). */
export function reportJson(r: HumanizeResult): JsonValue {
  return {
    nSamples: r.nSamples,
    requests: r.requests,
    seconds: Math.round(r.seconds * 10) / 10,
    warnings: r.warnings,
    kept: r.kept,
    keepActive: r.keepActive,
    keepIgnored: r.keepIgnored,
    variants: r.variants,
    pieces: r.pieces.map((p) => ({
      id: p.id,
      kind: p.kind,
      line: p.line,
      words: p.words,
      chosen: p.chosen,
      seconds: Math.round(p.seconds * 10) / 10,
      candidates: p.candidates.map((c) => ({
        text: c.text,
        copyRate: c.copyRate,
        issues: c.issues,
        missingNumbers: c.missingNumbers,
        addedNumbers: c.addedNumbers,
        missingUrls: c.missingUrls,
        languageResampled: c.languageResampled,
        keepTries: c.keepTries,
        seconds: Math.round(c.seconds * 10) / 10,
      })),
    })),
  } as unknown as JsonValue
}

type HumanizeArgs = { text: string; n_samples?: number; keep?: string[] }

function charCount(s: string): number {
  return Array.from(s).length
}

export function presentHumanizeCall(args: HumanizeArgs): ToolCallView {
  const n = typeof args.text === 'string' ? charCount(args.text) : 0
  const k = clampSamples(args.n_samples)
  return {
    card: 'generic',
    title: `去 AI 味改写（${n} 字符${k > 1 ? ` · ${k} 个候选` : ''}）`,
    kind: 'other',
    rawInput: {
      chars: n,
      n_samples: k,
      ...Array.isArray(args.keep) && args.keep.length > 0 ? { keep: args.keep } : {},
    },
  }
}

function rewrittenFrom(result: { content: ContentBlock[]; meta?: JsonValue }): { text?: string; warnings: number } {
  const meta = result.meta as { text?: unknown; warnings?: unknown } | undefined
  if (meta && typeof meta.text === 'string') {
    return { text: meta.text, warnings: Array.isArray(meta.warnings) ? meta.warnings.length : 0 }
  }
  const body = result.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : '')).join('\n')
  const m = /<rewritten>\n([\s\S]*?)\n<\/rewritten>/.exec(body)
  return { ...m ? { text: m[1]! } : {}, warnings: (body.match(/^- /gm) ?? []).length }
}

/** Completed card: an inline diff original → rewrite, the title carrying the warning count. */
export function presentHumanizeResult(args: HumanizeArgs, result: { content: ContentBlock[]; isError: boolean; meta?: JsonValue }): ToolResultView {
  if (result.isError || typeof args.text !== 'string') return { card: 'generic' }
  const { text, warnings } = rewrittenFrom(result)
  if (text === undefined) return { card: 'generic' }
  return {
    card: 'diff',
    title: `去 AI 味改写完成${warnings > 0 ? ` · ${warnings} 条提醒` : ''}`,
    diffs: [{ path: '去AI味.md', oldText: args.text, newText: text }],
  }
}

/** Minimal shape of the credentials service used here (dsh-credentials). */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  describe?(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
}

/** Resolve the Bearer key for one call: credentials service → launch environment → literal. */
async function resolveApiKey(ctx: Context, config: ResolvedConfig): Promise<string | undefined> {
  const envName = config.apiKeyEnv
  if (envName && isCredentialRefName(envName)) {
    const ref = credentialRef(envName)
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref)
      if (resolved?.value) return resolved.value
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    }
  }
  return config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
}

/** Whether a key is available for `envName` — status only, the value is never returned. */
async function keyStatus(ctx: Context, config: ResolvedConfig): Promise<{ ref: string; configured: boolean; source?: string; writable?: boolean; literal: boolean }> {
  const ref = config.apiKeyEnv
  const literal = config.apiKey !== undefined && config.apiKey.length > 0
  if (!ref || !isCredentialRefName(ref)) return { ref, configured: literal, literal }
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (credentials?.describe) {
    try {
      const d = await credentials.describe(credentialRef(ref))
      return { ref, configured: d.configured || literal, ...d.source ? { source: d.source } : {}, writable: d.writable, literal }
    } catch { /* fall through to a resolve probe */ }
  }
  const { apiKey: _literal, ...noLiteral } = config
  const key = await resolveApiKey(ctx, noLiteral)
  return { ref, configured: key !== undefined || literal, literal }
}

/** Factory seam for tests: build the backend for one call. */
export type BackendFactory = (config: ResolvedConfig, apiKey: () => Promise<string | undefined>) => HumanizerBackend

export const defaultBackendFactory: BackendFactory = (config, apiKey) => new LlamaServerClient({
  baseURL: config.baseURL,
  apiKey,
  requestTimeoutMs: config.requestTimeoutMs,
  sampling: config.sampling,
  retryDelaysMs: retryDelays(config.busyRetries),
})

let backendFactory: BackendFactory = defaultBackendFactory

/** Test hook: replace the backend factory; returns a restore function. */
export function setBackendFactory(factory: BackendFactory): () => void {
  const prev = backendFactory
  backendFactory = factory
  return () => { backendFactory = prev }
}

function systemPromptHint(toolName: string): string {
  return `When the user asks to 去AI味 / humanize / make a text sound less AI-written, call the ${toolName} tool with their draft verbatim instead of rewriting it yourself, then hand back its <rewritten> text unchanged and relay its warnings.`
}

function registerHint(ctx: Context, toolName: string): void {
  ctx.systemPrompt.section({ name: `tool:${toolName}`, order: 117, text: systemPromptHint(toolName) })
}

function registerTool(ctx: Context, current: () => ResolvedConfig, toolName: string, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    timeoutMs,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The draft to rewrite, verbatim (plain text or Markdown, English or Chinese).',
      },
      n_samples: {
        type: 'integer',
        description: 'Number of alternative versions, 1–4 (default from the plugin settings, normally 1). Use 2–4 when the user asks for several versions. Slower in proportion.',
      },
      keep: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional exact substrings of `text` that must stay word-for-word (names, terms, quotations the user asked to keep). Each must appear verbatim in `text`. Not for ordinary numbers/dates (already checked).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rendered: { type: 'string', required: true },
          text: { type: 'string', required: true },
          report: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }],
      presentationMeta: (_args, value) => ({ text: value.text, warnings: (value.report as { warnings?: JsonValue } | null)?.warnings ?? [] }),
    },
    async execute(args, exec) {
      const cfg = current()
      const text = args.text
      if (typeof text !== 'string' || !text.trim()) throw new Error(`${toolName}: \`text\` is empty`)
      const chars = charCount(text)
      if (chars > cfg.maxChars) {
        throw new Error(`${toolName}: text has ${chars} characters, above the configured limit of ${cfg.maxChars}; split it and call the tool per part`)
      }
      const backend = backendFactory(cfg, () => resolveApiKey(ctx, cfg))
      const keep = [
        ...cfg.defaultKeep.filter((k) => k && text.includes(k)),
        ...Array.isArray(args.keep) ? args.keep.filter((k): k is string => typeof k === 'string') : [],
      ]
      // Every request is queued per endpoint inside the client (-np 1), shared with UI jobs.
      const result = await humanize(text, backend, {
        nSamples: clampSamples(args.n_samples ?? cfg.defaultSamples),
        keep: [...new Set(keep)],
        maxCopy: cfg.maxCopy,
        retries: cfg.retries,
        langRetries: cfg.langRetries,
        factTries: cfg.factTries,
        maxWords: cfg.maxWords,
        maxCjk: cfg.maxCjk,
        maxPredict: cfg.maxPredict,
        signal: exec.signal,
      })
      return { rendered: renderReport(result), text: result.text, report: reportJson(result) }
    },
    presentCall: (args) => presentHumanizeCall(args as HumanizeArgs),
    presentResult: (args, result) => presentHumanizeResult(args as HumanizeArgs, result),
  }))
}

interface Disposable { dispose(): unknown }

/**
 * Keep one optional part (tool, prompt hint, web API) mounted as a child plugin whose identity
 * follows the settings it was built from: an unchanged key keeps it, a new key remounts it, an
 * undefined key removes it. That is how the toggles and the tool name apply without a restart.
 */
class Parts {
  private readonly mounted = new Map<string, { key: string; fiber: Disposable }>()
  constructor(private readonly ctx: Context) {}
  sync(id: string, key: string | undefined, inject: string[], mount: (c: Context) => void): void {
    const cur = this.mounted.get(id)
    if (cur?.key === key) return
    if (cur) { void cur.fiber.dispose(); this.mounted.delete(id) }
    if (key === undefined) return
    const fiber = this.ctx.plugin({ name: `tool-humanize:${id}`, inject, apply: mount } as never, undefined as never) as unknown as Disposable
    this.mounted.set(id, { key, fiber })
  }
  keys(): Record<string, string> {
    return Object.fromEntries([...this.mounted].map(([id, m]) => [id, m.key]))
  }
}

export function apply(ctx: Context, config: Config): void {
  if (promptFingerprint() !== FINGERPRINT) {
    // Never rewrite with a prompt the model was not trained on (upstream pins this in 3 places).
    throw new Error(`tool-humanize: prompt fingerprint ${promptFingerprint()} != ${FINGERPRINT}`)
  }
  // Volatile fields are references whose values a settings save replaces in place: read them per
  // operation, never cache a snapshot across calls.
  const current = (): ResolvedConfig => {
    const s = readSettings(config) as ResolvedConfig
    const literal = literalKey(config)
    if (literal !== undefined) s.apiKey = literal
    return s
  }
  const parts = new Parts(ctx)
  const sync = (): void => {
    const s = current()
    parts.sync('tool', s.toolEnabled ? `${s.toolName}|${s.toolTimeoutMs}` : undefined, ['tools'], (c) => { registerTool(c, current, s.toolName, s.toolTimeoutMs) })
    parts.sync('hint', s.toolEnabled && s.promptSection ? s.toolName : undefined, ['systemPrompt'], (c) => { registerHint(c, s.toolName) })
    parts.sync('web', s.webUi ? 'on' : undefined, [], (c) => { registerWebUi(c, current) })
  }
  sync()
  ;(ctx as unknown as { on(name: string, cb: () => void): () => void }).on('loader/volatile-update', sync)
}

/** Minimal shape of the official `webServer` service (dsh-host-webserver) used here. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
}

/**
 * Mount the UI API when the host has a web server (web profiles). The browser half (lib/client.js,
 * declared through package.json `dsh.client`) talks to it with the dsh session cookie; requests
 * without a valid session are rejected by the official connection guard.
 */
function registerWebUi(ctx: Context, current: () => ResolvedConfig): void {
  const injectable = ctx as unknown as { inject(deps: string[], cb: (c: Context) => void): void }
  if (typeof injectable.inject !== 'function') return
  injectable.inject(['webServer'], (sub) => {
    const webServer = (sub as unknown as { get(name: string): unknown }).get('webServer') as WebServerLike | undefined
    if (!webServer || typeof webServer.register !== 'function') return
    const web = new HumanizerWeb({
      limits: () => {
        const cfg = current()
        return {
          maxChars: cfg.maxChars,
          maxWords: cfg.maxWords,
          maxCjk: cfg.maxCjk,
          maxCopy: cfg.maxCopy,
          retries: cfg.retries,
          maxPredict: cfg.maxPredict,
          baseURL: cfg.baseURL,
          toolName: cfg.toolName,
          defaultSamples: cfg.defaultSamples,
          defaultKeep: cfg.defaultKeep,
          langRetries: cfg.langRetries,
          factTries: cfg.factTries,
        }
      },
      backend: () => { const cfg = current(); return backendFactory(cfg, () => resolveApiKey(ctx, cfg)) },
      settings: settingsFace(ctx, current),
      authorize: (req) => {
        const connection = (sub as unknown as { get(name: string): unknown }).get('connection') as ConnectionLike | undefined
        if (!connection || typeof connection.requestRejection !== 'function') return 503
        return connection.requestRejection(req)
      },
      logger: { warn: (m) => { try { (sub as unknown as { logger?: { warn(x: string): void } }).logger?.warn(m) } catch { /* no logger */ } } },
    })
    sub.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: web.handle }), 'tool-humanize: ui api')
    sub.effect(() => () => { web.dispose() }, 'tool-humanize: ui jobs')
  })
}

/** The read/probe face behind GET /api/settings and POST /api/settings/test. */
export function settingsFace(ctx: Context, current: () => ResolvedConfig): WebSettings {
  return {
    async describe() {
      const cfg = current()
      const { apiKey: _hidden, ...settings } = cfg
      return {
        settings,
        key: await keyStatus(ctx, cfg),
        deviations: samplingDeviations(cfg),
        entry: (ctx as unknown as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry?.options?.id ?? null,
      }
    },
    async test(overrides, signal) {
      const cfg: ResolvedConfig = { ...current(), ...overrides }
      const backend = backendFactory(cfg, () => resolveApiKey(ctx, cfg))
      const key = await keyStatus(ctx, cfg)
      let endpoint = cfg.baseURL
      try { const u = new URL(cfg.baseURL); endpoint = `${u.protocol}//${u.host}` } catch { /* keep */ }
      const probe: ProbeResult = backend.probe
        ? await backend.probe(signal)
        : { health: backend.health ? await backend.health(signal) : { ok: true, message: 'no probe' }, auth: { ok: false, message: 'backend has no probe' } }
      return { endpoint, key, ...probe }
    },
  }
}
