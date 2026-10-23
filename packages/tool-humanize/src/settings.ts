/**
 * Host Config of tool-humanize. Every field the settings page edits is declared `.volatile()`, so
 * dsh's own settings service (@deepseek-ai/dsh-settings) serves it to the Plugins page, validates
 * edits against this schema, persists them into the active profile's cordis.patch.yml, and commits
 * them into the running plugin without a restart (`loader/volatile-update`). The literal `apiKey`
 * stays an ordinary secret field: it is never served to a browser; keys are written through the
 * credentials service under the `apiKeyEnv` reference instead.
 * @module dsh-tool-humanize/settings
 */
import z from '@deepseek-ai/schemastery'
import { FIELDS } from './settings-meta.ts'
import type { FieldMeta } from './settings-meta.ts'

export interface Sampling {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
  repeat_penalty: number
}

/** Plain, fully resolved settings (one snapshot; read again for the next operation). */
export interface Settings {
  baseURL: string
  apiKeyEnv: string
  requestTimeoutMs: number
  busyRetries: number
  defaultSamples: number
  defaultKeep: string[]
  maxChars: number
  maxWords: number
  maxCjk: number
  maxCopy: number
  langRetries: number
  retries: number
  factTries: number
  sampling: Sampling
  maxPredict: number
  toolEnabled: boolean
  promptSection: boolean
  webUi: boolean
  toolName: string
  toolTimeoutMs: number
}

/** User-facing config (all optional; the schema fills defaults). */
export type Config = Partial<Omit<Settings, 'sampling'>> & {
  sampling?: Partial<Sampling>
  /** Literal key; prefer `apiKeyEnv`. Never served to the browser. */
  apiKey?: string
}

function fieldSchema(meta: FieldMeta): z {
  const desc = `${meta.zh.label} / ${meta.en.label} — ${meta.zh.detail ?? meta.zh.hint}`
  let s: z
  switch (meta.kind) {
    case 'bool': s = z.boolean().default(meta.default as boolean); break
    case 'list': s = z.array(z.string()).default([...(meta.default as readonly string[])]); break
    case 'text': {
      let t = z.string()
      if (meta.key === 'apiKeyEnv') t = t.role('credential-ref')
      if (meta.pattern) t = t.pattern(new RegExp(meta.pattern))
      s = t.default(meta.default as string)
      break
    }
    default: {
      let n = meta.kind === 'int' ? z.number().step(1) : z.number()
      if (meta.min !== undefined) n = n.min(meta.min)
      if (meta.max !== undefined) n = n.max(meta.max)
      s = n.default(meta.default as number)
    }
  }
  return s.description(desc).volatile() as unknown as z
}

function buildConfig(): z<Config> {
  const top: Record<string, z> = {}
  const sampling: Record<string, z> = {}
  for (const meta of FIELDS) {
    if (meta.path.length === 2 && meta.path[0] === 'sampling') sampling[meta.path[1]!] = fieldSchema(meta)
    else top[meta.key] = fieldSchema(meta)
    if (meta.key === 'apiKeyEnv') {
      top.apiKey = z.string().role('secret').description('字面密钥（不推荐，请用 apiKeyEnv 引用凭据） / Literal key (prefer apiKeyEnv)')
    }
  }
  top.sampling = z.object(sampling).default({}).description('采样参数（官方评测值） / Sampling (official evaluation)')
  return z.object(top).description('去 AI 味（humanizer）/ Humanize text') as unknown as z<Config>
}

export const Config: z<Config> = buildConfig()

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function unwrap(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && VOLATILE_WRITE in v && typeof (v as { get?: unknown }).get === 'function') {
    return (v as unknown as { get(): unknown }).get()
  }
  return v
}

function defaults(): Settings {
  const out: Record<string, unknown> = { sampling: {} }
  for (const meta of FIELDS) {
    const d = Array.isArray(meta.default) ? [...meta.default] : meta.default
    if (meta.path.length === 2) (out.sampling as Record<string, unknown>)[meta.path[1]!] = d
    else out[meta.key] = d
  }
  return out as unknown as Settings
}

/** Official/default values of every field (what "恢复默认" falls back to). */
export const DEFAULTS: Readonly<Settings> = Object.freeze(defaults())

/**
 * Read the current values out of the plugin's (possibly volatile) config. Call it per operation:
 * a settings save replaces the snapshots behind the references in place.
 */
export function readSettings(config: unknown): Settings {
  const c = (config ?? {}) as Record<string, unknown>
  const out = defaults() as unknown as Record<string, unknown>
  for (const meta of FIELDS) {
    let v: unknown
    if (meta.path.length === 2) {
      const group = unwrap(c[meta.path[0]!]) as Record<string, unknown> | undefined
      v = unwrap(group?.[meta.path[1]!])
    } else {
      v = unwrap(c[meta.key])
    }
    if (v === undefined || v === null) continue
    if (meta.path.length === 2) (out.sampling as Record<string, unknown>)[meta.path[1]!] = v
    else out[meta.key] = Array.isArray(v) ? [...(v as string[])] : v
  }
  return out as unknown as Settings
}

/** The literal key, if configured (ordinary field). */
export function literalKey(config: unknown): string | undefined {
  const v = unwrap((config as Record<string, unknown> | undefined)?.apiKey)
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Settings with `sampling` values that differ from the evaluated ones. */
export function samplingDeviations(s: Settings): string[] {
  const out: string[] = []
  for (const meta of FIELDS) {
    if (!meta.official) continue
    const v = meta.path.length === 2 ? (s.sampling as unknown as Record<string, unknown>)[meta.path[1]!] : (s as unknown as Record<string, unknown>)[meta.key]
    if (v !== meta.default) out.push(meta.key)
  }
  return out
}
