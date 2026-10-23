import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SettingsModel, formatValue, parseDraft } from '../../src/client/settings/model.ts'
import type { FormScope, PathOp } from '../../src/client/settings/model.ts'
import { SettingsPage } from '../../src/client/settings/SettingsPage.tsx'
import { settingsBridge } from '../../src/client/settings/bridge.ts'
import { apply, RowConfig, ROW_CONFIG_KEY } from '../../src/client/index.tsx'
import { FIELD_BY_KEY } from '../../src/settings-meta.ts'

const KEY = 'sk-never-shown-789'

/** In-memory stand-in for dsh's ConfigForm of the `tool-humanize` entry. */
function fakeScope(user: Record<string, unknown> = {}, base: Record<string, unknown> = { baseURL: 'http://llm.example:18080', apiKeyEnv: 'HUMANIZER_TEST_API_KEY' }) {
  const listeners = new Set<() => void>()
  const state = { user: structuredClone(user), revision: 1, accept: true }
  const calls: Array<{ ops: readonly PathOp[]; rev?: number | undefined }> = []
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge((a[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>) : v
    return out
  }
  let snap = (): ReturnType<FormScope['getSnapshot']> => ({ status: 'ready', value: merge(base, state.user), base, user: state.user, revision: state.revision, writable: true })
  let current = snap()
  const scope: FormScope = {
    getSnapshot: () => current,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    async mutate(ops, rev) {
      calls.push({ ops, rev })
      if (!state.accept) return false
      for (const op of ops) {
        let obj = state.user as Record<string, unknown>
        for (const k of op.path.slice(0, -1)) obj = (obj[k] ??= {}) as Record<string, unknown>
        const last = op.path[op.path.length - 1]!
        if (op.op === 'set') obj[last] = op.value
        else delete obj[last]
      }
      state.revision++
      current = snap()
      for (const fn of listeners) fn()
      return true
    },
  }
  return { scope, calls, state, setUnavailable: () => { snap = () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }); current = snap() } }
}

function fakeCredentials(configured = true) {
  const sets: Array<[string, string]> = []
  const unsets: string[] = []
  const described: string[][] = []
  return {
    sets,
    unsets,
    described,
    remote: {
      describe: async (refs: string[]) => { described.push(refs); return { ok: true, value: Object.fromEntries(refs.map((r) => [r, { configured: configured || sets.some(([x]) => x === r), source: 'file', writable: true }])) } },
      set: async (ref: string, value: string) => { sets.push([ref, value]); return { ok: true, value: undefined } },
      unset: async (ref: string) => { unsets.push(ref); configured = false; return { ok: true, value: undefined } },
    },
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('settings model', () => {
  it('converts drafts by field kind and validates like the host', () => {
    const m = (k: string) => FIELD_BY_KEY.get(k)!
    expect(parseDraft(m('defaultSamples'), '3')).toEqual({ kind: 'set', value: 3 })
    expect(parseDraft(m('defaultSamples'), '9')).toMatchObject({ kind: 'error' })
    expect(parseDraft(m('defaultSamples'), '')).toEqual({ kind: 'clear' })
    expect(parseDraft(m('sampling.top_p'), '0.9')).toEqual({ kind: 'set', value: 0.9 })
    expect(parseDraft(m('baseURL'), 'htp:/x')).toMatchObject({ kind: 'error' })
    expect(parseDraft(m('defaultKeep'), '星火计划，用户第一')).toEqual({ kind: 'set', value: ['星火计划', '用户第一'] })
    expect(parseDraft(m('webUi'), 'false')).toEqual({ kind: 'set', value: false })
    expect(formatValue(m('defaultKeep'), ['a', 'b'])).toBe('a, b')
  })

  it('stages edits and saves them as one fenced mutation with nested paths', async () => {
    const f = fakeScope()
    const c = fakeCredentials()
    let saved = 0
    const model = new SettingsModel(f.scope, c.remote, { onSaved: () => { saved++ } })
    await tick()
    expect(model.getSnapshot().credential).toMatchObject({ ref: 'HUMANIZER_TEST_API_KEY', configured: true })
    model.edit('defaultSamples', '2')
    model.edit('sampling.temperature', '0.7')
    model.edit('defaultKeep', '星火计划')
    model.edit('maxWords', '350') // unchanged → no write
    const v = model.getSnapshot()
    expect(v.dirty).toBe(true)
    expect(v.deviations).toEqual(['sampling.temperature'])
    expect(model.plan()).toEqual([
      { op: 'set', path: ['defaultSamples'], value: 2 },
      { op: 'set', path: ['sampling', 'temperature'], value: 0.7 },
      { op: 'set', path: ['defaultKeep'], value: ['星火计划'] },
    ])
    expect(await model.save()).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.rev).toBe(1)
    expect(f.state.user).toEqual({ defaultSamples: 2, sampling: { temperature: 0.7 }, defaultKeep: ['星火计划'] })
    expect(saved).toBe(1)
    const after = model.getSnapshot()
    expect(after.dirty).toBe(false)
    expect(after.fields.defaultSamples).toMatchObject({ value: 2, customized: true, dirty: false })
    expect(after.fields['sampling.temperature']).toMatchObject({ value: 0.7, customized: true })
    expect(after.toast).toMatchObject({ kind: 'ok', text: '已保存，立即生效' })
    expect(c.sets).toEqual([])
  })

  it('restores the official sampling defaults by clearing the overrides', async () => {
    const f = fakeScope({ sampling: { temperature: 0.7, top_k: 40 }, maxPredict: 1024, defaultSamples: 2 })
    const model = new SettingsModel(f.scope, undefined)
    expect(model.getSnapshot().deviations).toEqual(['sampling.temperature', 'sampling.top_k', 'maxPredict'])
    model.restoreOfficial()
    expect(model.getSnapshot().deviations).toEqual([])
    expect(model.plan()).toEqual([
      { op: 'unset', path: ['sampling', 'temperature'] },
      { op: 'unset', path: ['sampling', 'top_k'] },
      { op: 'unset', path: ['maxPredict'] },
    ])
    await model.save()
    expect(f.state.user).toEqual({ sampling: {}, defaultSamples: 2 })
    model.resetAll()
    await model.save()
    expect(f.state.user).toEqual({ sampling: {} })
    // Only volatile leaf paths are ever written (dsh refuses whole-object edits).
    expect(f.calls.flatMap((c) => c.ops).every((o) => FIELD_BY_KEY.has(o.path.join('.')))).toBe(true)
  })

  it('blocks saving invalid drafts and keeps drafts when the host refuses', async () => {
    const f = fakeScope()
    const model = new SettingsModel(f.scope, undefined)
    model.edit('maxCopy', '1.5')
    expect(model.getSnapshot()).toMatchObject({ invalid: true })
    expect(model.getSnapshot().fields.maxCopy!.error).toContain('1')
    expect(await model.save()).toBe(false)
    expect(f.calls).toHaveLength(0)
    model.edit('maxCopy', '0.6')
    f.state.accept = false
    expect(await model.save()).toBe(false)
    expect(model.getSnapshot().saveError).toContain('没有接受')
    expect(model.getSnapshot().fields.maxCopy!.text).toBe('0.6')
  })

  it('writes the key through the credentials service only, under the referenced name', async () => {
    const f = fakeScope()
    const c = fakeCredentials(false)
    const model = new SettingsModel(f.scope, c.remote)
    await tick()
    expect(model.getSnapshot().credential.configured).toBe(false)
    model.edit('apiKeyEnv', 'HUMANIZER_OTHER_KEY')
    model.setKeyDraft(KEY)
    expect(await model.save()).toBe(true)
    expect(f.state.user).toEqual({ apiKeyEnv: 'HUMANIZER_OTHER_KEY' })
    expect(c.sets).toEqual([['HUMANIZER_OTHER_KEY', KEY]])
    const v = model.getSnapshot()
    expect(v.keyDraft).toBe('')
    expect(v.credential).toMatchObject({ ref: 'HUMANIZER_OTHER_KEY', configured: true })
    expect(JSON.stringify(f.calls)).not.toContain(KEY)
    expect(renderToString(createElement(SettingsPage, { model }))).not.toContain(KEY)
  })

  it('tests the connection with the draft URL and reference', async () => {
    const f = fakeScope()
    const bodies: unknown[] = []
    const model = new SettingsModel(f.scope, undefined, { probe: async (b) => { bodies.push(b); return { endpoint: 'http://x:1', health: { ok: true, status: 200 }, auth: { ok: true, status: 200, ms: 5 } } } })
    model.edit('baseURL', 'http://x:1')
    await model.runTest()
    expect(bodies).toEqual([{ baseURL: 'http://x:1', apiKeyEnv: 'HUMANIZER_TEST_API_KEY' }])
    expect(model.getSnapshot().test.result?.auth?.ok).toBe(true)
    const html = renderToString(createElement(SettingsPage, { model })).replaceAll('<!-- -->', '')
    // Connection card: live state with latency; probe details sit behind 详情.
    expect(html).toContain('已连接 · 5 ms')
    expect(html).toContain('hzs-led ok')
    expect(html).toContain('使用尚未保存的地址检测')
  })

  it('shows times in seconds/minutes and ranges only in error messages', () => {
    const m = (k: string) => FIELD_BY_KEY.get(k)!
    expect(formatValue(m('requestTimeoutMs'), 600_000)).toBe('600')
    expect(formatValue(m('toolTimeoutMs'), 1_800_000)).toBe('30')
    expect(parseDraft(m('requestTimeoutMs'), '90')).toEqual({ kind: 'set', value: 90_000 })
    expect(parseDraft(m('toolTimeoutMs'), '2.5')).toEqual({ kind: 'set', value: 150_000 })
    expect(parseDraft(m('requestTimeoutMs'), '0.5')).toEqual({ kind: 'error', error: '超出范围：1–3600 秒' })
    expect(parseDraft(m('requestTimeoutMs'), 'abc', 'en')).toEqual({ kind: 'error', error: 'Enter a number (1–3600 s)' })
    for (const f of [m('requestTimeoutMs'), m('maxCopy'), m('maxChars')]) expect(f.zh.hint).not.toMatch(/\d{4,}|\[|–/)
  })

  it('compares by value: leftovers equal to the defaults are not "customized"; restore-all writes a minimal entry', async () => {
    // The host left baseURL/apiKeyEnv in the entry with the same values as the bundle base.
    const f = fakeScope({ baseURL: 'http://llm.example:18080', apiKeyEnv: 'HUMANIZER_TEST_API_KEY', defaultSamples: 1, maxWords: 300 })
    const model = new SettingsModel(f.scope, undefined)
    const v = model.getSnapshot()
    expect(v.fields.baseURL!.customized).toBe(false)
    expect(v.fields.apiKeyEnv!.customized).toBe(false)
    expect(v.fields.defaultSamples!.customized).toBe(false)
    expect(v.fields.maxWords!.customized).toBe(true)
    expect(v.dirty).toBe(false)
    expect(await model.restoreAllNow()).toBe(true)
    expect(f.calls.at(-1)!.ops).toEqual([
      { op: 'unset', path: ['baseURL'] },
      { op: 'unset', path: ['apiKeyEnv'] },
      { op: 'unset', path: ['defaultSamples'] },
      { op: 'unset', path: ['maxWords'] },
    ])
    expect(f.state.user).toEqual({})
    const after = model.getSnapshot()
    expect(Object.values(after.fields).filter((x) => x.customized || x.dirty)).toEqual([])
    expect(after.toast?.text).toBe('已恢复全部默认设置')
    expect(renderToString(createElement(SettingsPage, { model, open: ['limits', 'checks', 'sampling', 'network', 'tool'] }))).not.toContain('hzs-reset"')
  })

  it('counts unsaved items (fields + pending key) and resetting a field back to its saved value clears it', () => {
    const f = fakeScope({ maxWords: 300 })
    const model = new SettingsModel(f.scope, undefined)
    model.edit('defaultSamples', '3')
    model.setKeyDraft(KEY)
    expect(model.getSnapshot().unsaved).toBe(2)
    model.edit('defaultSamples', '1')
    expect(model.getSnapshot().unsaved).toBe(1)
    model.reset('maxWords')
    expect(model.getSnapshot().fields.maxWords).toMatchObject({ value: 350, customized: false, dirty: true })
    expect(model.plan()).toEqual([{ op: 'unset', path: ['maxWords'] }])
    model.discard()
    expect(model.getSnapshot()).toMatchObject({ dirty: false, unsaved: 0, keyDraft: '' })
  })

  it('clears the key through credentials.unset only when the service supports it', async () => {
    const c = fakeCredentials(true)
    const model = new SettingsModel(fakeScope().scope, c.remote)
    await tick()
    expect(model.canClearKey()).toBe(true)
    expect(await model.clearKey()).toBe(true)
    expect(c.unsets).toEqual(['HUMANIZER_TEST_API_KEY'])
    expect(model.getSnapshot().credential.configured).toBe(false)
    expect(model.getSnapshot().toast?.text).toBe('密钥已清除')
    // The connection card re-checks after the key or the reference changes.
    let probes = 0
    const m3 = new SettingsModel(fakeScope().scope, c.remote, { probe: async () => { probes++; return { health: { ok: true } } } })
    m3.ensureTested(); await tick()
    expect(probes).toBe(1)
    m3.edit('defaultSamples', '2'); await m3.save(); await tick()
    expect(probes).toBe(1)
    m3.edit('apiKeyEnv', 'OTHER_REF'); await m3.save(); await tick()
    expect(probes).toBe(2)
    await m3.clearKey(); await tick()
    expect(probes).toBe(3)
    const noUnset = { describe: c.remote.describe, set: c.remote.set }
    const m2 = new SettingsModel(fakeScope().scope, noUnset)
    expect(m2.canClearKey()).toBe(false)
    expect(await m2.clearKey()).toBe(false)
  })
})

describe('settings page', () => {
  it('renders every group, the key status and the sampling warning (zh + en)', async () => {
    const f = fakeScope({ sampling: { top_p: 0.8 } })
    const model = new SettingsModel(f.scope, fakeCredentials(true).remote)
    await tick()
    const zh = renderToString(createElement(SettingsPage, { model })).replaceAll('<!-- -->', '')
    // Hierarchy: connection card, 常用, collapsed 高级 sections with their badges.
    for (const s of ['llm.example:18080', '测试连接', 'API 密钥', '已配置 · 凭据文件', '更换', '清除', '常用', '默认候选数', 'role="radiogroup"', '总是保留的词', 'role="switch"', '智能体工具', '高级设置', '分段与长度', '质量检查', '采样参数', '已自定义 1 项', '超时与重试', '全部恢复默认', 'cordis.patch.yml']) {
      expect(zh, s).toContain(s)
    }
    // Advanced sections start closed; nothing unsaved → no bar; no raw ranges or ms anywhere.
    expect(zh).not.toContain('照抄率阈值')
    expect(zh).not.toContain('hzs-bar"')
    expect(zh).not.toContain('已修改')
    expect(zh).not.toMatch(/600000|3600000|\[1000/)
    const open = renderToString(createElement(SettingsPage, { model, open: ['sampling', 'network'] })).replaceAll('<!-- -->', '')
    expect(open).toContain('恢复官方默认')
    expect(open).toContain('采样参数已偏离官方评测值')
    expect(open).toContain('恢复默认（0.95）')
    expect(open).toMatch(/value="600"[^>]*>.*?秒/)
    model.edit('defaultSamples', '3')
    model.edit('maxWords', '10')
    const dirty = renderToString(createElement(SettingsPage, { model })).replaceAll('<!-- -->', '')
    expect(dirty).toContain('hzs-bar"')
    expect(dirty).toContain('有填写不正确的项')
    expect(dirty).toContain('超出范围：20–2000 词') // the invalid section opens itself
    model.edit('maxWords', '400')
    expect(renderToString(createElement(SettingsPage, { model })).replaceAll('<!-- -->', '')).toContain('有 2 项未保存')
    model.discard()
    const en = renderToString(createElement(SettingsPage, { model, lang: 'en', open: ['sampling'] })).replaceAll('<!-- -->', '')
    expect(en).toContain('Restore official defaults')
    expect(en).toContain('Default candidates')
    expect(en).toContain('Advanced')
    f.setUnavailable()
    const m2 = new SettingsModel(f.scope, undefined)
    expect(renderToString(createElement(SettingsPage, { model: m2 }))).toContain('设置暂不可用')
  })

  it('registers the Plugins-page row config while dsh serves the namespace, and feeds the panel', async () => {
    const f = fakeScope()
    const regs: Array<Record<string, unknown>> = []
    const effects: Array<() => () => void> = []
    const services: Record<string, unknown> = {
      configForms: { get: () => f.scope, whileServed: (_ns: string[], reg: () => () => void) => reg() },
      locale: { register: () => () => {}, bind: () => (k: string) => (k === 'lang' ? 'zh' : k) },
      remote: { credentials: fakeCredentials(true).remote },
    }
    const ctx = {
      slots: { inject: (_n: string, fn: () => unknown) => fn(), register: (o: Record<string, unknown>) => { regs.push(o); return () => {} } },
      effect: (fn: () => () => void) => { effects.push(fn) },
      get: (n: string) => services[n],
      inject: (_deps: string[], fn: (c: unknown) => void) => { fn(ctx) },
    }
    apply(ctx as never)
    for (const e of effects) e()
    const row = regs.find((r) => r.name === 'plugins.row.config')!
    expect(row.key).toBe(ROW_CONFIG_KEY)
    expect(ROW_CONFIG_KEY).toBe('dsh-tool-humanize#tool-humanize')
    const injected = (row.inject as () => { model: SettingsModel; lang: () => 'zh' | 'en' })()
    expect(settingsBridge.get()?.model).toBe(injected.model)
    expect(renderToString(createElement(RowConfig, { ...injected, view: 'summary' }))).toBe('llm.example:18080 · 默认 1 个候选')
    await tick()
    expect(renderToString(createElement(RowConfig, { ...injected, view: 'summary' }))).toBe('llm.example:18080 · 密钥已配置 · 默认 1 个候选')
    expect(renderToString(createElement(RowConfig, { ...injected, view: 'page' }))).toContain('高级设置')
  })
})
