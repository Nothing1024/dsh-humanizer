/**
 * Browser half of dsh-tool-humanize (loaded by dsh web through package.json `dsh.client`, like
 * vibee's ui-vibee): a 「去AI味」 row in the sidebar's global panel list and the matching main
 * panel, plus the plugin's settings page. Open the panel from the sidebar, or with `#humanizer`
 * in the dsh web URL.
 *
 * Settings use dsh's native mechanism: the host Config's fields are volatile, so dsh-settings
 * serves them as the `tool-humanize` configuration form; this half registers the form's page in
 * the Plugins page (`plugins.row.config`, key `dsh-tool-humanize#tool-humanize`) and reuses the
 * same model for the panel's 设置 view.
 * @module dsh-tool-humanize/client
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { HumanizerIcon, HumanizerPanel } from './Panel.tsx'
import { postJson } from './api.ts'
import { humanizerStore } from './store.ts'
import { ENTRY_ID, PACKAGE_NAME } from '../settings-meta.ts'
import { SettingsModel } from './settings/model.ts'
import type { CredentialsRemote, FormScope, ProbeView } from './settings/model.ts'
import { SettingsPage } from './settings/SettingsPage.tsx'
import type { Lang } from './settings/SettingsPage.tsx'
import { settingsBridge } from './settings/bridge.ts'

export const PANEL_ID = 'humanizer'
/** Plugins-page key of the row's configuration page. */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`
const LOCALE_NS = 'humanizer.settings'
/** Services the settings half needs (it mounts only when all are present). */
export const SETTINGS_INJECT = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** Platform services this half uses (`layout` only for the #humanizer deep link). */
export const inject = ['slots', 'layout']

interface SlotsLike {
  inject(name: string, fn: () => unknown): void | (() => void)
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ConfigFormsLike {
  get(id: string): FormScope
  whileServed(namespaces: string[], register: (served: Set<string>) => () => void): () => void
}

interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string) => string
}

interface ClientContext {
  slots: SlotsLike
  get?(name: string): unknown
  effect(fn: () => () => void, label?: string): void
  inject?(deps: string[], fn: (ctx: ClientContext) => void): unknown
}

const DICTS = {
  zh: { lang: 'zh' },
  en: { lang: 'en' },
}

/** The row's one-line state on the Plugins page, e.g. "127.0.0.1:8080 · 密钥已配置 · 默认 1 个候选". */
export function summaryText(model: SettingsModel, lang: Lang): string {
  const v = model.getSnapshot()
  if (v.status !== 'ready') return lang === 'en' ? 'Service, key, defaults and sampling' : '服务地址、密钥、默认值与采样参数'
  let host = String(v.fields.baseURL?.value ?? '')
  try { host = new URL(host).host } catch { /* keep raw */ }
  const c = v.credential
  const key = c.configured ? (lang === 'en' ? ' · key set' : ' · 密钥已配置') : c.known ? (lang === 'en' ? ' · no key' : ' · 密钥未配置') : ''
  const n = Number(v.fields.defaultSamples?.value ?? 1)
  const samples = lang === 'en' ? `${n} candidate${n > 1 ? 's' : ''} by default` : `默认 ${n} 个候选`
  const custom = v.deviations.length ? (lang === 'en' ? ' · custom sampling' : ' · 采样已自定义') : ''
  return `${host}${key} · ${samples}${custom}`
}

function Summary({ model, lang }: { model: SettingsModel; lang: Lang }): ReactNode {
  useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
  return summaryText(model, lang)
}

/** The `plugins.row.config` entry: the one-line state, or the settings page on the row's page. */
export function RowConfig(props: { view?: 'summary' | 'page'; model: SettingsModel; lang: () => Lang; t?: (key: string) => string }): ReactNode {
  const lang: Lang = props.t ? (props.t('lang') === 'en' ? 'en' : 'zh') : props.lang()
  if (props.view === 'summary') return <Summary model={props.model} lang={lang} />
  return <SettingsPage model={props.model} lang={lang} />
}

function mountSettings(ctx: ClientContext): void {
  const forms = ctx.get?.('configForms') as ConfigFormsLike | undefined
  if (!forms || typeof forms.get !== 'function') return
  const locale = ctx.get?.('locale') as LocaleLike | undefined
  let t: ((key: string) => string) | undefined
  if (locale && typeof locale.register === 'function') {
    ctx.effect(() => locale.register(LOCALE_NS, DICTS), 'tool-humanize: settings dictionaries')
    t = locale.bind(LOCALE_NS)
  }
  const lang = (): Lang => (t?.('lang') === 'en' ? 'en' : 'zh')
  const remote = ctx.get?.('remote') as { credentials?: CredentialsRemote } | undefined
  const model = new SettingsModel(forms.get(ENTRY_ID), remote?.credentials, {
    probe: (body) => postJson<ProbeView>('/settings/test', body),
    onSaved: () => { void humanizerStore().refreshInfo() },
  })
  settingsBridge.set({ model, lang })
  ctx.effect(() => () => { settingsBridge.set(undefined); model.dispose() }, 'tool-humanize: settings model')
  if (typeof forms.whileServed === 'function') {
    ctx.effect(() => forms.whileServed([ENTRY_ID], () => {
      const off = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
        ...t ? { locale: LOCALE_NS } : {},
        inject: () => ({ model, lang }),
      }, RowConfig))
      return typeof off === 'function' ? off : () => undefined
    }), 'tool-humanize: plugins-page settings')
  }
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, HumanizerPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: '去 AI 味',
  }, HumanizerIcon))
  // Settings are optional: without dsh's configuration forms (e.g. remote non-loopback pages) the
  // panel still works and its 设置 view explains where to configure.
  // cordis checks property access against the declared deps, so every service the settings half
  // touches is listed (the same set the official web-search settings page injects).
  if (typeof ctx.inject === 'function') ctx.inject(SETTINGS_INJECT, (sub) => { mountSettings(sub) })
  const open = (): void => {
    if (typeof location === 'undefined') return
    const layout = ctx.get?.('layout') as { selectPanel?(id: string): void } | undefined
    if (location.hash === `#${PANEL_ID}` || location.hash === `#${PANEL_ID}/settings`) {
      if (location.hash.endsWith('/settings')) humanizerStore().setPage('settings')
      try { layout?.selectPanel?.(PANEL_ID) } catch { /* panel not registered yet */ }
    }
  }
  if (typeof window !== 'undefined') {
    ctx.effect(() => {
      const t = setTimeout(open, 300)
      window.addEventListener('hashchange', open)
      return () => { clearTimeout(t); window.removeEventListener('hashchange', open) }
    }, 'tool-humanize: #humanizer deep link')
  }
}
