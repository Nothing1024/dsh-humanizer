/**
 * The humanizer settings page, rendered both on dsh's Plugins page (the `tool-humanize` row's
 * configure page) and in the 去AI味 panel's 设置 view — one component, one model, one persistence.
 *
 * Layout: a connection card (service, key, live state), 常用 settings, then 高级 sections that
 * start collapsed. Edits are staged; a sticky bar appears only while something is unsaved
 * (⌘S / Ctrl+S saves), and a toast confirms the save.
 * @module dsh-tool-humanize/client/settings/SettingsPage
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { FIELDS, SECTIONS, displayNumber, rangeText, splitTerms } from '../../settings-meta.ts'
import type { Copy, FieldMeta, SectionId } from '../../settings-meta.ts'
import type { FieldView, Lang, ProbeView, SettingsModel, SettingsView } from './model.ts'
import { ensureSettingsStyles } from './styles.ts'

export type { Lang } from './model.ts'

const TEXT = {
  zh: {
    intro: '修改保存后立即生效，无需重启。',
    persist: '设置由 dsh 保存到当前 profile 的 cordis.patch.yml（tool-humanize 条目），与「插件」页和去 AI 味面板里的设置是同一份。API 密钥单独保存在 ~/.dsh/.credentials.yaml，任何页面都读不到它的值。',
    unavailable: '设置暂不可用：dsh 没有向此页面提供 tool-humanize 的配置。请确认插件已加载，并从本机地址（127.0.0.1）打开 dsh web。',
    loading: '正在读取设置…',
    readOnly: '当前部署的设置为只读，无法保存。',
    // connection card
    checking: '正在检测…',
    connected: '已连接',
    unreachable: '无法连接',
    keyRejected: '服务可达，但密钥被拒绝',
    notTested: '尚未检测',
    probeFailed: '检测失败',
    test: '测试连接',
    testing: '检测中…',
    edit: '修改',
    done: '完成',
    details: '详情',
    hideDetails: '收起',
    draftNote: '使用尚未保存的地址检测',
    openWarn: '不带密钥也能访问：服务端没有校验密钥',
    health: '服务状态',
    auth: '带密钥请求',
    tokens: 'token',
    key: 'API 密钥',
    keySet: '已配置',
    keyUnset: '未配置',
    keyUnknown: '状态未知',
    keyChange: '更换',
    keyAdd: '设置密钥',
    keyClear: '清除',
    keyCancel: '取消',
    keyShow: '显示',
    keyHide: '隐藏',
    keyPlaceholder: '粘贴新的 API 密钥',
    keyPending: '新密钥将在保存时写入',
    keyHint: '保存后写入 ~/.dsh/.credentials.yaml，之后不会再显示。',
    keyEnvOnly: '此密钥由启动时的环境变量提供，这里不能修改',
    src: { file: '凭据文件', env: '环境变量', environment: '环境变量', credentials: '凭据文件' } as Record<string, string>,
    // sections
    advanced: '高级设置',
    advancedHint: '一般不需要修改',
    customizedN: '已自定义 {n} 项',
    official: '官方默认',
    restoreOfficial: '恢复官方默认',
    deviate: '采样参数已偏离官方评测值，改写效果不再对应官方评测结果。建议只在实验时修改。',
    resetField: '恢复默认（{v}）',
    unsavedDot: '未保存的修改',
    on: '开',
    off: '关',
    addTerm: '输入后回车添加',
    removeTerm: '移除 {t}',
    noTerms: '暂无',
    // save
    unsaved: '有 {n} 项未保存',
    save: '保存',
    saving: '保存中…',
    discard: '放弃',
    invalid: '有填写不正确的项',
    resetAll: '全部恢复默认…',
    resetAllHint: '清除所有自定义设置（不影响已保存的密钥）',
    confirmResetTitle: '全部恢复默认？',
    confirmResetBody: '所有设置都将恢复为默认值并立即保存，未保存的修改也会被丢弃。API 密钥不受影响。',
    confirmReset: '恢复默认',
    confirmClearTitle: '清除 API 密钥？',
    confirmClearBody: '将从 ~/.dsh/.credentials.yaml 中删除 {ref}。清除后改写会因缺少密钥而失败，直到重新设置。',
    confirmClear: '清除',
    cancel: '取消',
    shortcut: '⌘S',
    leaveTitle: '有未保存的修改',
    leaveBody: '有 {n} 项修改还没有保存。',
    leaveSave: '保存并返回',
    leaveDiscard: '放弃修改',
    on_: '已开启',
  },
  en: {
    intro: 'Changes apply as soon as you save — no restart needed.',
    persist: 'dsh stores these settings in the profile\'s cordis.patch.yml (tool-humanize entry); the Plugins page and the panel edit the same settings. The API key is stored separately in ~/.dsh/.credentials.yaml and no page can read its value.',
    unavailable: 'Settings are unavailable: dsh does not serve the tool-humanize configuration to this page. Make sure the plugin is loaded and open dsh web from a loopback address (127.0.0.1).',
    loading: 'Loading settings…',
    readOnly: 'Settings are read-only in this deployment.',
    checking: 'Checking…',
    connected: 'Connected',
    unreachable: 'Unreachable',
    keyRejected: 'Reachable, but the key was rejected',
    notTested: 'Not checked yet',
    probeFailed: 'Check failed',
    test: 'Test connection',
    testing: 'Checking…',
    edit: 'Edit',
    done: 'Done',
    details: 'Details',
    hideDetails: 'Hide',
    draftNote: 'Checked with the unsaved address',
    openWarn: 'Works without a key: the server does not check keys',
    health: 'Health',
    auth: 'Request with key',
    tokens: 'tokens',
    key: 'API key',
    keySet: 'Configured',
    keyUnset: 'Not set',
    keyUnknown: 'Unknown',
    keyChange: 'Change',
    keyAdd: 'Set key',
    keyClear: 'Clear',
    keyCancel: 'Cancel',
    keyShow: 'Show',
    keyHide: 'Hide',
    keyPlaceholder: 'Paste the new API key',
    keyPending: 'The new key is written when you save',
    keyHint: 'Saved to ~/.dsh/.credentials.yaml and never shown again.',
    keyEnvOnly: 'Provided by an environment variable at startup; cannot be changed here',
    src: { file: 'credentials file', env: 'environment', environment: 'environment', credentials: 'credentials file' } as Record<string, string>,
    advanced: 'Advanced',
    advancedHint: 'Rarely needs changing',
    customizedN: '{n} customized',
    official: 'Official defaults',
    restoreOfficial: 'Restore official defaults',
    deviate: 'Sampling differs from the officially evaluated values, so results no longer match the official evaluation. Change only for experiments.',
    resetField: 'Reset to default ({v})',
    unsavedDot: 'Unsaved change',
    on: 'On',
    off: 'Off',
    addTerm: 'Type and press Enter',
    removeTerm: 'Remove {t}',
    noTerms: 'None',
    unsaved: '{n} unsaved change(s)',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard',
    invalid: 'Some values are invalid',
    resetAll: 'Reset all to defaults…',
    resetAllHint: 'Removes every customization (the stored key is kept)',
    confirmResetTitle: 'Reset all settings?',
    confirmResetBody: 'Every setting returns to its default and is saved right away; unsaved edits are discarded. The API key is not affected.',
    confirmReset: 'Reset',
    confirmClearTitle: 'Clear the API key?',
    confirmClearBody: 'Deletes {ref} from ~/.dsh/.credentials.yaml. Rewrites fail without a key until you set one again.',
    confirmClear: 'Clear',
    cancel: 'Cancel',
    shortcut: 'Ctrl+S',
    leaveTitle: 'Unsaved changes',
    leaveBody: '{n} change(s) are not saved yet.',
    leaveSave: 'Save and go back',
    leaveDiscard: 'Discard',
    on_: 'On',
  },
}

type T = typeof TEXT.zh

function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function useSettings(model: SettingsModel): SettingsView {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

/** Confirm dialog (shared with the panel's leave guard). */
export function Confirm(props: { title: string; body: string; actions: Array<{ label: string; kind?: 'primary' | 'danger'; onClick: () => void }>; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button[data-autofocus]')?.focus()
    const onKey = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])
  return (
    <div className="hzs-modal" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className="hzs-dialog" role="alertdialog" aria-modal="true" aria-labelledby="hzs-dialog-title" ref={ref}>
        <h3 id="hzs-dialog-title">{props.title}</h3>
        <p>{props.body}</p>
        <div className="hzs-dialog-actions">
          {props.actions.map((a, i) => (
            <button key={a.label} type="button" data-autofocus={i === props.actions.length - 1 ? '' : undefined} className={`hzs-btn ${a.kind ?? ''}`} onClick={a.onClick}>{a.label}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Info({ text }: { text?: string | undefined }): ReactNode {
  if (!text) return null
  return (
    <span className="hzs-info" tabIndex={0} role="img" aria-label={text}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 7.2v3.6M8 5.1v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      <span className="hzs-tip" role="tooltip">{text}</span>
    </span>
  )
}

export interface SettingsPageProps {
  model: SettingsModel
  lang?: Lang
  /** Show the connection test (needs the plugin's /humanizer routes). */
  probe?: boolean
  /** Sections open initially (tests / deep links). */
  open?: readonly SectionId[]
}

export function SettingsPage({ model, lang = 'zh', probe = true, open = [] }: SettingsPageProps): ReactNode {
  ensureSettingsStyles()
  const v = useSettings(model)
  const t = TEXT[lang]
  const [confirm, setConfirm] = useState<'reset' | 'clear' | undefined>()
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { model.setLang(lang) }, [model, lang])
  useEffect(() => { if (probe) model.ensureTested() }, [model, probe, v.status])

  // ⌘S / Ctrl+S saves while the page is on screen; leaving the browser tab warns while unsaved.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's' && rootRef.current?.isConnected) {
        e.preventDefault()
        if (model.getSnapshot().dirty) void model.save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [model])
  useEffect(() => {
    if (typeof window === 'undefined' || !v.dirty) return
    const onUnload = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onUnload)
    return () => { window.removeEventListener('beforeunload', onUnload) }
  }, [v.dirty])
  useEffect(() => {
    if (!v.toast) return
    const id = v.toast.id
    const timer = setTimeout(() => { model.dismissToast(id) }, 2600)
    return () => { clearTimeout(timer) }
  }, [model, v.toast?.id])

  if (v.status === 'loading') return <div className="hzs" ref={rootRef}><p className="hzs-dim">{t.loading}</p></div>
  if (v.status === 'unavailable') return <div className="hzs" ref={rootRef}><p className="hzs-notice">{t.unavailable}</p></div>

  const disabled = !v.writable || v.saving
  const bySection = (id: SectionId): FieldView[] => FIELDS.filter((m) => m.section === id).map((m) => v.fields[m.key]!)

  return (
    <div className={`hzs${v.dirty ? ' has-bar' : ''}`} ref={rootRef} data-lang={lang}>
      <p className="hzs-intro">{t.intro}<Info text={t.persist} /></p>
      {!v.writable ? <p className="hzs-notice">{t.readOnly}</p> : null}

      <ConnectionCard v={v} model={model} t={t} lang={lang} probe={probe} disabled={disabled} onClear={() => { setConfirm('clear') }} />

      <section className="hzs-section" aria-labelledby="hzs-sec-common">
        <h4 id="hzs-sec-common" className="hzs-section-title">{SECTIONS.find((s) => s.id === 'common')![lang].label}</h4>
        <div className="hzs-card hzs-rows">
          {bySection('common').map((f) => <Field key={f.meta.key} f={f} model={model} lang={lang} t={t} disabled={disabled} />)}
        </div>
      </section>

      <section className="hzs-section">
        <h4 className="hzs-section-title">{t.advanced}<span className="hzs-dim"> · {t.advancedHint}</span></h4>
        <div className="hzs-adv">
          {SECTIONS.filter((s) => s.advanced).map((s) => (
            <Advanced key={s.id} id={s.id} copy={s[lang]} fields={bySection(s.id)} v={v} model={model} lang={lang} t={t} disabled={disabled} initiallyOpen={open.includes(s.id)} />
          ))}
        </div>
        <div className="hzs-resetall">
          <button type="button" className="hzs-btn danger-ghost" disabled={disabled} onClick={() => { setConfirm('reset') }}>{t.resetAll}</button>
          <span className="hzs-dim">{t.resetAllHint}</span>
        </div>
      </section>

      {v.dirty || v.saveError ? (
        <div className="hzs-bar" role="region" aria-label={fill(t.unsaved, { n: v.unsaved })}>
          <span className={`hzs-bar-dot${v.invalid ? ' bad' : ''}`} />
          <span className="hzs-bar-text">
            {v.saveError ? <span className="hzs-err">{v.saveError}</span> : v.invalid ? <span className="hzs-err">{t.invalid}</span> : fill(t.unsaved, { n: v.unsaved })}
          </span>
          <span className="hzs-grow" />
          <button type="button" className="hzs-btn" disabled={v.saving} onClick={() => { model.discard() }}>{t.discard}</button>
          <button type="button" className="hzs-btn primary" disabled={disabled || v.invalid || !v.dirty} onClick={() => { void model.save() }} title={isMac ? '⌘S' : 'Ctrl+S'}>
            {v.saving ? t.saving : t.save}<kbd>{isMac ? '⌘S' : 'Ctrl+S'}</kbd>
          </button>
        </div>
      ) : null}

      {v.toast ? <div className={`hzs-toast ${v.toast.kind}`} role="status" aria-live="polite">{v.toast.kind === 'ok' ? '✓ ' : ''}{v.toast.text}</div> : null}

      {confirm === 'reset' ? (
        <Confirm title={t.confirmResetTitle} body={t.confirmResetBody} onClose={() => { setConfirm(undefined) }}
          actions={[{ label: t.cancel, onClick: () => { setConfirm(undefined) } }, { label: t.confirmReset, kind: 'danger', onClick: () => { setConfirm(undefined); void model.restoreAllNow() } }]} />
      ) : null}
      {confirm === 'clear' ? (
        <Confirm title={t.confirmClearTitle} body={fill(t.confirmClearBody, { ref: v.credential.ref })} onClose={() => { setConfirm(undefined) }}
          actions={[{ label: t.cancel, onClick: () => { setConfirm(undefined) } }, { label: t.confirmClear, kind: 'danger', onClick: () => { setConfirm(undefined); void model.clearKey() } }]} />
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- connection card */

type ConnState = { kind: 'idle' | 'checking' | 'ok' | 'warn' | 'bad'; text: string; sub?: string | undefined }

function connState(v: SettingsView, t: T): ConnState {
  const { test } = v
  if (test.running) return { kind: 'checking', text: t.checking }
  if (test.error) return { kind: 'bad', text: t.probeFailed, sub: test.error }
  const r = test.result
  if (!r) return { kind: 'idle', text: t.notTested }
  if (!r.health?.ok) return { kind: 'bad', text: t.unreachable, sub: r.health?.message ?? (r.health?.status ? `HTTP ${r.health.status}` : undefined) }
  if (!r.auth?.ok) return { kind: 'warn', text: r.auth?.status === 401 || r.auth?.status === 403 ? t.keyRejected : t.probeFailed, sub: r.auth?.message ?? (r.auth?.status ? `HTTP ${r.auth.status}` : undefined) }
  return { kind: r.open ? 'warn' : 'ok', text: r.auth.ms !== undefined ? `${t.connected} · ${r.auth.ms} ms` : t.connected, sub: r.open ? t.openWarn : undefined }
}

function hostOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  try { const u = new URL(url); return u.host + (u.pathname !== '/' ? u.pathname : '') } catch { return url }
}

function ConnectionCard({ v, model, t, lang, probe, disabled, onClear }: { v: SettingsView; model: SettingsModel; t: T; lang: Lang; probe: boolean; disabled: boolean; onClear: () => void }): ReactNode {
  const url = v.fields.baseURL!
  const ref = v.fields.apiKeyEnv!
  const [editing, setEditing] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [details, setDetails] = useState(false)
  // A saved (or discarded) key closes the key editor.
  useEffect(() => { if (!v.keyDraft) { setKeyOpen(false); setReveal(false) } }, [v.savedAt])
  const st = connState(v, t)
  const c = v.credential
  const src = c.source ? (t.src[c.source] ?? c.source) : ''
  const showEdit = editing || !!url.error || !!ref.error || url.dirty || ref.dirty
  const keyEditing = keyOpen || !!v.keyDraft
  const r = v.test.result
  return (
    <section className="hzs-card hzs-conn" aria-label={SECTIONS[0]![lang].label}>
      <div className="hzs-conn-head">
        <span className={`hzs-led ${st.kind}`} aria-hidden="true" />
        <div className="hzs-conn-id">
          <div className="hzs-conn-host" title={typeof url.value === 'string' ? url.value : ''}>{hostOf(url.value) || '—'}{url.dirty || ref.dirty ? <i className="hzs-dot" title={t.unsavedDot} /> : null}</div>
          <div className={`hzs-conn-state ${st.kind}`} aria-live="polite">
            {st.text}
            {st.sub ? <span className="hzs-dim"> · {st.sub}</span> : null}
            {r && (url.dirty || ref.dirty) && !v.test.running ? <span className="hzs-dim"> · {t.draftNote}</span> : null}
          </div>
        </div>
        <span className="hzs-grow" />
        <div className="hzs-conn-actions">
          {probe ? <button type="button" className="hzs-btn" disabled={v.test.running} onClick={() => { void model.runTest() }}>{v.test.running ? t.testing : t.test}</button> : null}
          <button type="button" className="hzs-btn ghost" aria-expanded={showEdit} disabled={!!url.error || !!ref.error} onClick={() => { setEditing(!showEdit) }}>{showEdit ? t.done : t.edit}</button>
        </div>
      </div>

      {showEdit ? (
        <div className="hzs-rows hzs-conn-edit">
          <Field f={url} model={model} lang={lang} t={t} disabled={disabled} />
          <Field f={ref} model={model} lang={lang} t={t} disabled={disabled} />
        </div>
      ) : null}

      <div className="hzs-conn-key">
        <span className="hzs-conn-label">{t.key}</span>
        <span className={`hzs-badge ${c.configured ? 'ok' : c.known ? 'bad' : ''}`}>
          {c.configured ? t.keySet : c.known ? t.keyUnset : t.keyUnknown}{c.configured && src ? ` · ${src}` : ''}
        </span>
        <code className="hzs-dim hzs-ref" title={c.ref}>{c.ref}</code>
        <span className="hzs-grow" />
        {c.writable ? (
          <>
            {!keyEditing ? <button type="button" className="hzs-btn ghost" disabled={disabled} onClick={() => { setKeyOpen(true); setReveal(false) }}>{c.configured ? t.keyChange : t.keyAdd}</button> : null}
            {c.configured && model.canClearKey() && !keyEditing ? <button type="button" className="hzs-btn ghost danger" disabled={disabled || v.keyBusy} onClick={onClear}>{t.keyClear}</button> : null}
          </>
        ) : <span className="hzs-dim">{t.keyEnvOnly}</span>}
      </div>
      {keyEditing && c.writable ? (
        <div className="hzs-keyedit">
          <div className="hzs-pw">
            <input
              className="hzs-input"
              type={reveal ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={t.keyPlaceholder}
              aria-label={t.key}
              value={v.keyDraft}
              disabled={disabled}
              autoFocus
              onChange={(e) => { model.setKeyDraft(e.target.value) }}
            />
            <button type="button" className="hzs-pw-eye" aria-pressed={reveal} aria-label={reveal ? t.keyHide : t.keyShow} onClick={() => { setReveal(!reveal) }}>{reveal ? t.keyHide : t.keyShow}</button>
          </div>
          <button type="button" className="hzs-btn ghost" onClick={() => { model.setKeyDraft(''); setKeyOpen(false); setReveal(false) }}>{t.keyCancel}</button>
          <p className="hzs-hint">{v.keyDraft ? <><i className="hzs-dot" /> {t.keyPending}</> : t.keyHint}</p>
        </div>
      ) : null}

      {r && (r.health || r.auth) ? (
        <div className="hzs-conn-more">
          <button type="button" className="hzs-link" aria-expanded={details} onClick={() => { setDetails(!details) }}>{details ? t.hideDetails : t.details}</button>
          {details ? <ProbeDetails r={r} t={t} /> : null}
        </div>
      ) : null}
    </section>
  )
}

function ProbeDetails({ r, t }: { r: ProbeView; t: T }): ReactNode {
  return (
    <ul className="hzs-probe">
      {r.endpoint ? <li className="hzs-dim"><code>{r.endpoint}</code></li> : null}
      {r.health ? <li className={r.health.ok ? 'ok' : 'bad'}><b>{r.health.ok ? '✓' : '✕'}</b> {t.health} <code>/health</code> {r.health.status ? `HTTP ${r.health.status}` : ''} {r.health.message ?? ''}</li> : null}
      {r.auth ? <li className={r.auth.ok ? 'ok' : 'bad'}><b>{r.auth.ok ? '✓' : '✕'}</b> {t.auth} <code>/tokenize</code> {r.auth.status ? `HTTP ${r.auth.status}` : ''}{r.auth.ms !== undefined ? ` · ${r.auth.ms} ms` : ''}{r.auth.tokens !== undefined ? ` · ${r.auth.tokens} ${t.tokens}` : ''} {r.auth.ok ? '' : r.auth.message ?? ''}</li> : null}
      {r.open ? <li className="warn">⚠ {t.openWarn}</li> : null}
    </ul>
  )
}

/* ---------------------------------------------------------------- advanced sections */

function Advanced({ id, copy, fields, v, model, lang, t, disabled, initiallyOpen }: { id: SectionId; copy: Copy; fields: FieldView[]; v: SettingsView; model: SettingsModel; lang: Lang; t: T; disabled: boolean; initiallyOpen: boolean }): ReactNode {
  const [open, setOpen] = useState(initiallyOpen)
  const attention = fields.some((f) => f.error)
  const isOpen = open || attention
  const custom = fields.filter((f) => f.customized).length
  const dirty = fields.some((f) => f.dirty)
  const sampling = id === 'sampling'
  return (
    <div className={`hzs-acc${isOpen ? ' open' : ''}`} data-section={id}>
      <button type="button" className="hzs-acc-head" aria-expanded={isOpen} onClick={() => { setOpen(!isOpen) }}>
        <svg className="hzs-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="hzs-acc-title">{copy.label}{dirty ? <i className="hzs-dot" title={t.unsavedDot} /> : null}</span>
        <span className="hzs-acc-hint">{copy.hint}</span>
        <span className="hzs-grow" />
        {sampling
          ? <span className={`hzs-badge ${v.deviations.length ? 'warn' : 'ok'}`}>{v.deviations.length ? fill(t.customizedN, { n: v.deviations.length }) : t.official}</span>
          : custom ? <span className="hzs-badge">{fill(t.customizedN, { n: custom })}</span> : null}
      </button>
      {isOpen ? (
        <div className="hzs-acc-body">
          {sampling && v.deviations.length ? (
            <div className="hzs-warn">
              <span>{t.deviate}</span>
              <button type="button" className="hzs-btn" disabled={disabled} onClick={() => { model.restoreOfficial() }}>{t.restoreOfficial}</button>
            </div>
          ) : null}
          <div className="hzs-rows">
            {fields.map((f) => <Field key={f.meta.key} f={f} model={model} lang={lang} t={t} disabled={disabled} />)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- one field */

function defaultText(meta: FieldMeta, lang: Lang, t: T): string {
  const d = meta.default
  if (typeof d === 'boolean') return d ? t.on : t.off
  if (Array.isArray(d)) return d.length ? d.join(', ') : t.noTerms
  if (typeof d === 'number') return `${displayNumber(d / (meta.scale ?? 1))}${meta.unit ? ` ${meta.unit[lang]}` : ''}`
  return String(d)
}

function Field({ f, model, lang, t, disabled }: { f: FieldView; model: SettingsModel; lang: Lang; t: T; disabled: boolean }): ReactNode {
  const m = f.meta
  const c = m[lang]
  const id = `hzs-f-${m.key.replace(/\./g, '-')}`
  const wide = m.control === 'chips' || (m.control === 'text' && m.key === 'baseURL')
  return (
    <div className={`hzs-row${f.error ? ' bad' : ''}${f.dirty ? ' dirty' : ''}${wide ? ' wide' : ''}`} data-key={m.key}>
      <div className="hzs-row-text">
        <label className="hzs-label" htmlFor={id}>
          {f.dirty ? <i className="hzs-dot" title={t.unsavedDot} aria-label={t.unsavedDot} /> : null}
          {m.official ? <code>{c.label}</code> : c.label}
          <Info text={c.detail} />
        </label>
        <p className="hzs-hint">{c.hint}</p>
      </div>
      <div className="hzs-row-ctl">
        <Control f={f} id={id} model={model} lang={lang} t={t} disabled={disabled} />
        {f.customized && m.control !== 'switch' ? (
          <button type="button" className="hzs-reset" disabled={disabled} title={fill(t.resetField, { v: defaultText(m, lang, t) })} aria-label={fill(t.resetField, { v: defaultText(m, lang, t) })} onClick={() => { model.reset(m.key) }}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6.5A4.8 4.8 0 1 1 3.2 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M3 3.2v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ) : <span className="hzs-reset-gap" />}
      </div>
      {f.error ? <p className="hzs-errmsg" role="alert">{f.error}</p> : null}
    </div>
  )
}

function num(text: string, fallback: number): number {
  const n = Number(text.trim())
  return Number.isFinite(n) && text.trim() !== '' ? n : fallback
}

function Control({ f, id, model, lang, t, disabled }: { f: FieldView; id: string; model: SettingsModel; lang: Lang; t: T; disabled: boolean }): ReactNode {
  const m = f.meta
  const edit = (text: string): void => { model.edit(m.key, text) }
  const scale = m.scale ?? 1
  const lo = m.min !== undefined ? m.min / scale : undefined
  const hi = m.max !== undefined ? m.max / scale : undefined
  const step = m.step ?? 1
  const unit = m.unit ? <span className="hzs-unit">{m.unit[lang]}</span> : null
  switch (m.control) {
    case 'switch': {
      const on = f.text === 'true'
      return (
        <button type="button" id={id} role="switch" aria-checked={on} className={`hzs-switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => { edit(on ? 'false' : 'true') }}>
          <i />
          <span className="hzs-sr">{on ? t.on : t.off}</span>
        </button>
      )
    }
    case 'segmented': {
      const cur = num(f.text, Number(m.default))
      const opts: number[] = []
      for (let n = lo ?? 1; n <= (hi ?? 4); n++) opts.push(n)
      return (
        <div className="hzs-seg" role="radiogroup" id={id}>
          {opts.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={cur === n} className={cur === n ? 'on' : ''} disabled={disabled} onClick={() => { edit(String(n)) }}>{n}</button>
          ))}
        </div>
      )
    }
    case 'chips': return <Chips id={id} terms={splitTerms(f.text)} onChange={(terms) => { edit(terms.join('\n')) }} t={t} disabled={disabled} />
    case 'stepper': {
      const cur = num(f.text, Number(m.default) / scale)
      const set = (n: number): void => { edit(displayNumber(Math.min(hi ?? n, Math.max(lo ?? n, n)))) }
      return (
        <div className="hzs-stepper">
          <button type="button" aria-label="−" disabled={disabled || (lo !== undefined && cur <= lo)} onClick={() => { set(cur - step) }}>−</button>
          <input id={id} className="hzs-input" inputMode="numeric" value={f.text} disabled={disabled} aria-invalid={!!f.error} onChange={(e) => { edit(e.target.value) }} />
          <button type="button" aria-label="+" disabled={disabled || (hi !== undefined && cur >= hi)} onClick={() => { set(cur + step) }}>+</button>
        </div>
      )
    }
    case 'slider': {
      const cur = num(f.text, Number(m.default))
      return (
        <div className="hzs-slider">
          <input type="range" min={lo} max={hi} step={step} value={Math.min(hi ?? cur, Math.max(lo ?? cur, cur))} disabled={disabled} aria-label={m[lang].label}
            onChange={(e) => { edit(displayNumber(Number(e.target.value))) }} />
          <input id={id} className="hzs-input num xs" inputMode="decimal" value={f.text} disabled={disabled} aria-invalid={!!f.error} onChange={(e) => { edit(e.target.value) }} />
        </div>
      )
    }
    case 'number':
    case 'duration':
      return (
        <div className="hzs-num">
          <input id={id} className="hzs-input num" inputMode="decimal" value={f.text} disabled={disabled} aria-invalid={!!f.error} placeholder={rangeText(m, lang)}
            onChange={(e) => { edit(e.target.value) }}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
              e.preventDefault()
              const cur = num(f.text, Number(m.default) / scale)
              const next = cur + (e.key === 'ArrowUp' ? step : -step)
              edit(displayNumber(Math.min(hi ?? next, Math.max(lo ?? next, next))))
            }} />
          {unit}
        </div>
      )
    default:
      return <input id={id} className="hzs-input" value={f.text} disabled={disabled} spellCheck={false} aria-invalid={!!f.error} onChange={(e) => { edit(e.target.value) }} />
  }
}

function Chips({ id, terms, onChange, t, disabled }: { id: string; terms: string[]; onChange: (terms: string[]) => void; t: T; disabled: boolean }): ReactNode {
  const [text, setText] = useState('')
  const add = (raw: string): void => {
    const extra = splitTerms(raw).filter((x) => !terms.includes(x))
    if (extra.length) onChange([...terms, ...extra])
    setText('')
  }
  return (
    <div className={`hzs-chips${disabled ? ' disabled' : ''}`} onClick={(e) => { (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus() }}>
      {terms.map((x) => (
        <span key={x} className="hzs-chip">
          {x}
          <button type="button" aria-label={fill(t.removeTerm, { t: x })} disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange(terms.filter((y) => y !== x)) }}>×</button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        placeholder={terms.length ? '' : t.addTerm}
        onChange={(e) => {
          const val = e.target.value
          if (/[\n,，、;；]/.test(val)) add(val)
          else setText(val)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) add(text) }
          else if (e.key === 'Backspace' && !text && terms.length) onChange(terms.slice(0, -1))
        }}
        onBlur={() => { if (text.trim()) add(text) }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text')
          if (/[\n,，、;；]/.test(pasted)) { e.preventDefault(); add(text + pasted) }
        }}
      />
    </div>
  )
}
