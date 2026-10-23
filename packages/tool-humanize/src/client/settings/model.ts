/**
 * Staged settings form over dsh's own configuration form for the `tool-humanize` entry
 * (`ctx.configForms.get('tool-humanize')`, served by @deepseek-ai/dsh-settings): the user edits
 * drafts, 保存 sends one revision-fenced `mutate` (the host validates against the plugin's
 * schemastery Config, writes the profile's cordis.patch.yml and commits the values into the
 * running plugin). The API key is the one control outside the section: it is written through
 * `remote.credentials.set` under the `apiKeyEnv` reference and only its configured/unconfigured
 * state is ever read back.
 * @module dsh-tool-humanize/client/settings/model
 */
import { FIELDS, FIELD_BY_KEY, OFFICIAL_KEYS, checkValue, displayNumber, splitTerms } from '../../settings-meta.ts'
import type { FieldMeta } from '../../settings-meta.ts'

export type PathOp = { op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] }

/** What this model reads of the shared configuration form (ConfigForm in dsh-client-ui-settings). */
export interface FormScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: unknown
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<boolean>
}

export interface CredentialView { configured: boolean; source?: string; writable: boolean }

/** `ctx.remote.credentials` (dsh-api-settings-controller); answers are `{ ok, value }` envelopes. */
export interface CredentialsRemote {
  describe(refs: string[]): Promise<unknown>
  set(ref: string, value: string): Promise<unknown>
  /** Remove the stored key (dsh-api-settings-controller ≥ the version with `unset`). */
  unset?(ref: string): Promise<unknown>
}

export type Lang = 'zh' | 'en'

export interface ProbeView {
  endpoint?: string
  key?: { ref: string; configured: boolean; source?: string }
  health?: { ok: boolean; status?: number; message?: string }
  auth?: { ok: boolean; status?: number; message?: string; ms?: number; tokens?: number }
  open?: boolean
}

export interface FieldView {
  meta: FieldMeta
  /** Draft text (bool: 'true' / 'false'). */
  text: string
  /** Effective value the draft stands for (staged or saved). */
  value: unknown
  /** The (draft) value differs from the default it would inherit — compared by value. */
  customized: boolean
  /** Staged and not saved yet. */
  dirty: boolean
  error?: string | undefined
}

export interface SettingsView {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  fields: Record<string, FieldView>
  dirty: boolean
  /** Number of unsaved items (changed fields + a pending key). */
  unsaved: number
  invalid: boolean
  saving: boolean
  /** Message of the last save ('' after success). */
  saveError?: string | undefined
  savedAt?: number | undefined
  keyDraft: string
  credential: CredentialView & { ref: string; known: boolean }
  /** Official sampling keys whose (draft) value differs from the evaluated one. */
  deviations: string[]
  test: { running: boolean; result?: ProbeView | undefined; error?: string | undefined; at?: number | undefined }
  /** Transient message for a toast (id changes per message). */
  toast?: { id: number; kind: 'ok' | 'error'; text: string } | undefined
  /** A key operation (clear) in flight. */
  keyBusy: boolean
}

type Staged = { kind: 'text'; text: string } | { kind: 'clear' }

function at(obj: unknown, path: readonly string[]): unknown {
  let cur = obj
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function has(obj: unknown, path: readonly string[]): boolean {
  let cur = obj
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as object))) return false
    cur = (cur as Record<string, unknown>)[k]
  }
  return true
}

/** Stored value → draft text (numbers in display units, e.g. ms shown as seconds). */
export function formatValue(meta: FieldMeta, v: unknown): string {
  if (v === undefined || v === null) return ''
  if (meta.kind === 'list') return Array.isArray(v) ? v.join(', ') : ''
  if (meta.kind === 'bool') return v ? 'true' : 'false'
  if (typeof v === 'number') return displayNumber(v / (meta.scale ?? 1))
  return String(v)
}

/**
 * Draft text → value. `clear` = empty draft (re-inherit the default); `error` blocks saving.
 */
export function parseDraft(meta: FieldMeta, text: string, lang: Lang = 'zh'): { kind: 'clear' } | { kind: 'set'; value: unknown } | { kind: 'error'; error: string } {
  const t = text.trim()
  if (meta.kind === 'bool') return { kind: 'set', value: t === 'true' }
  if (meta.kind === 'list') {
    const terms = splitTerms(text)
    const err = checkValue(meta, terms, lang)
    return err ? { kind: 'error', error: err } : { kind: 'set', value: terms }
  }
  if (!t) return { kind: 'clear' }
  let value: unknown = t
  if (meta.kind !== 'text') {
    const n = Number(t)
    const scale = meta.scale ?? 1
    // Display units → stored units; whole seconds/minutes map onto whole milliseconds.
    value = Number.isFinite(n) && scale !== 1 ? Math.round(n * scale) : n
  }
  const err = checkValue(meta, value, lang)
  return err ? { kind: 'error', error: err } : { kind: 'set', value }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function envelope<T>(r: unknown): { ok: boolean; value?: T; message?: string } {
  if (r && typeof r === 'object' && 'ok' in r) {
    const e = r as { ok: boolean; value?: T; error?: { message?: string } | string }
    const message = typeof e.error === 'string' ? e.error : e.error?.message
    return { ok: !!e.ok, ...e.value !== undefined ? { value: e.value } : {}, ...message ? { message } : {} }
  }
  return { ok: true, value: r as T }
}

export interface ModelOptions {
  /** POST /humanizer/api/settings/test (injectable for tests). */
  probe?: (body: { baseURL?: string; apiKeyEnv?: string }) => Promise<ProbeView>
  /** Called after a save the host accepted (e.g. refresh the panel's defaults). */
  onSaved?: () => void
}

export class SettingsModel {
  private readonly staged = new Map<string, Staged>()
  private keyDraft = ''
  private saving = false
  private saveError: string | undefined
  private savedAt: number | undefined
  private credential: CredentialView & { ref: string; known: boolean } = { ref: '', configured: false, writable: true, known: false }
  private test: SettingsView['test'] = { running: false }
  private readonly listeners = new Set<() => void>()
  private view: SettingsView
  private readonly off: () => void
  private credSeq = 0
  private lang: Lang = 'zh'
  private toast: SettingsView['toast']
  private toastSeq = 0
  private keyBusy = false
  private tested = false

  constructor(private readonly scope: FormScope, private readonly credentials: CredentialsRemote | undefined, private readonly options: ModelOptions = {}) {
    this.view = this.project()
    this.off = scope.subscribe(() => { this.publish(); void this.readCredential() })
    void this.readCredential()
  }

  getSnapshot = (): SettingsView => this.view
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  dispose(): void { this.off(); this.listeners.clear() }

  /** Language of validation and status messages. */
  setLang(lang: Lang): void { if (lang !== this.lang) { this.lang = lang; this.publish() } }

  private say(zh: string, en: string): string { return this.lang === 'zh' ? zh : en }

  private notify(kind: 'ok' | 'error', text: string): void {
    this.toast = { id: ++this.toastSeq, kind, text }
  }

  /** Dismiss the toast (the page calls this after a few seconds). */
  dismissToast(id: number): void {
    if (this.toast?.id === id) { this.toast = undefined; this.publish() }
  }

  private publish(): void {
    this.view = this.project()
    for (const fn of this.listeners) fn()
  }

  private saved(meta: FieldMeta): unknown {
    const snap = this.scope.getSnapshot()
    const v = at(snap.value, meta.path)
    if (v !== undefined) return v
    const b = at(snap.base, meta.path)
    return b !== undefined ? b : meta.default
  }

  private inherited(meta: FieldMeta): unknown {
    const b = at(this.scope.getSnapshot().base, meta.path)
    return b !== undefined ? b : meta.default
  }

  private stored(meta: FieldMeta): boolean {
    return has(this.scope.getSnapshot().user, meta.path)
  }

  /** Reference the (draft) apiKeyEnv names. */
  private ref(): string {
    const f = this.view?.fields.apiKeyEnv
    const v = f && !f.error ? f.value : this.saved(FIELD_BY_KEY.get('apiKeyEnv')!)
    return typeof v === 'string' ? v : ''
  }

  private project(): SettingsView {
    const snap = this.scope.getSnapshot()
    const fields: Record<string, FieldView> = {}
    let unsaved = 0
    let invalid = false
    for (const meta of FIELDS) {
      const st = this.staged.get(meta.key)
      const inherited = this.inherited(meta)
      let fv: FieldView
      if (!st) {
        const value = this.saved(meta)
        // By value: an entry the host left behind that equals the default is not a customization.
        fv = { meta, text: formatValue(meta, value), value, customized: !same(value, inherited), dirty: false }
      } else {
        const p: ReturnType<typeof parseDraft> = st.kind === 'clear' ? { kind: 'clear' } : parseDraft(meta, st.text, this.lang)
        const text = st.kind === 'clear' ? formatValue(meta, inherited) : st.text
        if (p.kind === 'error') fv = { meta, text, value: undefined, customized: true, dirty: true, error: p.error }
        else {
          const value = p.kind === 'clear' ? inherited : p.value
          fv = { meta, text, value, customized: !same(value, inherited), dirty: !same(value, this.saved(meta)) }
        }
      }
      if (fv.dirty) unsaved++
      if (fv.error) invalid = true
      fields[meta.key] = fv
    }
    const deviations = OFFICIAL_KEYS.filter((k) => {
      const f = fields[k]!
      return f.value !== undefined && !same(f.value, f.meta.default)
    })
    if (this.keyDraft) unsaved++
    return {
      status: snap.status,
      writable: snap.writable,
      fields,
      dirty: unsaved > 0,
      unsaved,
      invalid,
      saving: this.saving,
      saveError: this.saveError,
      savedAt: this.savedAt,
      keyDraft: this.keyDraft,
      credential: this.credential,
      deviations,
      test: this.test,
      toast: this.toast,
      keyBusy: this.keyBusy,
    }
  }

  edit(key: string, text: string): void {
    if (!FIELD_BY_KEY.has(key)) return
    this.staged.set(key, { kind: 'text', text })
    this.saveError = undefined
    this.publish()
  }

  /** Stage a clear: the field re-inherits the bundle/schema default on save. */
  reset(key: string): void {
    if (!FIELD_BY_KEY.has(key)) return
    this.staged.set(key, { kind: 'clear' })
    this.saveError = undefined
    this.publish()
  }

  /** 恢复官方默认: stage a clear of every evaluated sampling field. */
  restoreOfficial(): void {
    for (const k of OFFICIAL_KEYS) this.staged.set(k, { kind: 'clear' })
    this.saveError = undefined
    this.publish()
  }

  /** Stage a clear of every field (the bundle defaults). */
  resetAll(): void {
    for (const meta of FIELDS) this.staged.set(meta.key, { kind: 'clear' })
    this.saveError = undefined
    this.publish()
  }

  /**
   * 全部恢复默认 (after the page's confirm): drop every stored field in one save, so the entry
   * keeps only what the host itself re-writes; a pending key draft is discarded.
   */
  async restoreAllNow(): Promise<boolean> {
    this.keyDraft = ''
    this.resetAll()
    const ok = await this.save(this.say('已恢复全部默认设置', 'All settings restored to defaults'))
    return ok
  }

  setKeyDraft(text: string): void { this.keyDraft = text; this.saveError = undefined; this.publish() }

  discard(): void {
    this.staged.clear()
    this.keyDraft = ''
    this.saveError = undefined
    this.publish()
  }

  /** The ordered edits a save would send. */
  plan(): PathOp[] {
    const ops: PathOp[] = []
    for (const [key, st] of this.staged) {
      const meta = FIELD_BY_KEY.get(key)!
      const p: ReturnType<typeof parseDraft> = st.kind === 'clear' ? { kind: 'clear' } : parseDraft(meta, st.text)
      if (p.kind === 'error') continue
      // A clear always unsets a stored entry (even one equal to the default): minimal config.
      if (p.kind === 'clear') { if (this.stored(meta)) ops.push({ op: 'unset', path: meta.path }); continue }
      if (same(p.value, this.saved(meta))) continue
      ops.push({ op: 'set', path: meta.path, value: p.value })
    }
    // Group objects (`sampling: {}`) stay: dsh only accepts edits at volatile leaf paths, and an
    // empty group equals its schema default.
    return ops
  }

  async save(message?: string): Promise<boolean> {
    const v = this.view
    if (this.saving || v.invalid || v.status !== 'ready' || !v.writable) return false
    const ops = this.plan()
    const key = this.keyDraft
    if (ops.length === 0 && !key) {
      this.staged.clear()
      if (message) this.notify('ok', message)
      this.publish()
      return true
    }
    this.saving = true
    this.saveError = undefined
    this.publish()
    let ok = true
    try {
      if (ops.length > 0) {
        ok = await this.scope.mutate(ops, this.scope.getSnapshot().revision)
        if (!ok) this.saveError = this.say('dsh 没有接受这些值（可能被其他配置层覆盖或已在别处修改），修改已保留', 'dsh did not accept these values (overridden by another layer or changed elsewhere); your edits are kept')
      }
      if (ok && key) {
        if (!this.credentials) throw new Error(this.say('当前页面无法写入凭据', 'This page cannot write credentials'))
        const ref = this.ref()
        const r = envelope<unknown>(await this.credentials.set(ref, key))
        if (!r.ok) { ok = false; this.saveError = this.say(`密钥没有保存：${r.message ?? '凭据服务拒绝写入'}`, `Key not saved: ${r.message ?? 'credential service refused'}`) } else this.keyDraft = ''
      }
      if (ok) {
        this.staged.clear()
        this.savedAt = Date.now()
        this.notify('ok', message ?? this.say('已保存，立即生效', 'Saved — applied immediately'))
      }
    } catch (error) {
      ok = false
      this.saveError = this.say(`保存失败：${(error as Error).message}`, `Save failed: ${(error as Error).message}`)
    } finally {
      this.saving = false
      this.publish()
    }
    if (ok) {
      await this.readCredential()
      this.options.onSaved?.()
      // The connection card shows a live state: re-check when what it depends on changed.
      if (key || ops.some((o) => o.path[0] === 'baseURL' || o.path[0] === 'apiKeyEnv')) this.recheck()
    }
    return ok
  }

  /** Whether the credentials service can delete a key (清除 is shown only then). */
  canClearKey(): boolean { return typeof this.credentials?.unset === 'function' }

  /** 清除 (after the page's confirm): delete the key stored under the current reference. */
  async clearKey(): Promise<boolean> {
    if (!this.credentials?.unset || this.keyBusy) return false
    const ref = this.ref()
    if (!ref) return false
    this.keyBusy = true
    this.publish()
    let ok = false
    try {
      const r = envelope<unknown>(await this.credentials.unset(ref))
      ok = r.ok
      this.notify(ok ? 'ok' : 'error', ok ? this.say('密钥已清除', 'Key cleared') : this.say(`没有清除：${r.message ?? '凭据服务拒绝'}`, `Not cleared: ${r.message ?? 'refused'}`))
    } catch (error) {
      this.notify('error', this.say(`没有清除：${(error as Error).message}`, `Not cleared: ${(error as Error).message}`))
    } finally {
      this.keyBusy = false
      this.publish()
    }
    await this.readCredential()
    if (ok) this.recheck()
    return ok
  }

  private recheck(): void {
    if (this.tested && this.options.probe) void this.runTest()
  }

  /** Run 测试连接 once per model so the connection card shows a live state. */
  ensureTested(): void {
    if (this.tested || !this.options.probe || this.view.status !== 'ready') return
    this.tested = true
    void this.runTest()
  }

  /** Ask the credentials service whether the referenced key is configured (never its value). */
  async readCredential(): Promise<void> {
    if (!this.credentials) return
    const ref = this.ref()
    if (!ref) return
    const seq = ++this.credSeq
    try {
      const r = envelope<Record<string, CredentialView>>(await this.credentials.describe([ref]))
      if (seq !== this.credSeq) return
      const view = r.ok ? r.value?.[ref] : undefined
      this.credential = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true, known: r.ok, ...view?.source ? { source: view.source } : {} }
    } catch {
      if (seq !== this.credSeq) return
      this.credential = { ref, configured: false, writable: true, known: false }
    }
    this.publish()
  }

  /** 测试连接 with the (valid) draft service URL and key reference. */
  async runTest(): Promise<void> {
    if (this.test.running || !this.options.probe) return
    const f = this.view.fields
    const body: { baseURL?: string; apiKeyEnv?: string } = {}
    if (!f.baseURL!.error && typeof f.baseURL!.value === 'string') body.baseURL = f.baseURL!.value
    if (!f.apiKeyEnv!.error && typeof f.apiKeyEnv!.value === 'string') body.apiKeyEnv = f.apiKeyEnv!.value
    this.tested = true
    this.test = { ...this.test, running: true }
    this.publish()
    try {
      this.test = { running: false, result: await this.options.probe(body), at: Date.now() }
    } catch (error) {
      this.test = { running: false, error: (error as Error).message, at: Date.now() }
    }
    this.publish()
  }
}
