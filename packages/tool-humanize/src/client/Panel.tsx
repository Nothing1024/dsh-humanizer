/**
 * The 去AI味 panel (dsh web main panel). Layout and behaviour follow the official Humanizer app
 * (sgaofen/humanizer-local-model app/web, Apache-2.0): draft on the left, rewrite on the right,
 * highlighter for newly written words, struck-through removed words in the draft view, "keep
 * verbatim" terms, number/link checks per piece, regenerate, copy and download. Added here:
 * 1–4 candidates per piece with switching, piece-by-piece streaming and cancel.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { DiffView } from './diff.ts'
import type { WireCandidate } from './api.ts'
import { canCompare, comparing, humanizerStore } from './store.ts'
import type { HumanizerStore, State, UnitView } from './store.ts'
import { CompareView, DRAFT_CLS, OUT_CLS, Runs, shownCandidate, useDocumentView, usePairedPanes, useUnitViews } from './Compare.tsx'
import { ensureStyles } from './styles.ts'
import { Confirm, SettingsPage } from './settings/SettingsPage.tsx'
import { settingsBridge } from './settings/bridge.ts'

const KIND_LABEL: Record<string, string> = { prose: '正文', item: '列表项', sentences: '长段' }

const ISSUE_LABEL: Record<string, string> = {
  empty: '改写为空',
  truncated: '被截断',
  too_short: '明显变短',
  too_long: '明显变长',
  repeated: '有重复句',
  language: '语言不一致',
  markup: '多了 HTML',
  copy: '照抄偏多',
  keep_failed: '保留失败，已退回原文',
}

function useStore(store: HumanizerStore): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function count(s: string): { units: number; chars: number } {
  const cjk = (s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []).length
  const latin = (s.replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ').match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu) ?? []).length
  return { units: cjk + latin, chars: Array.from(s).length }
}

async function copyText(store: HumanizerStore, text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    store.toast(`已复制${what}`, 'ok')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    store.toast(ok ? `已复制${what}` : '复制失败', ok ? 'ok' : 'err')
  }
}

function download(text: string, ext: 'md' | 'txt'): void {
  const blob = new Blob([text], { type: ext === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  a.href = URL.createObjectURL(blob)
  a.download = `去AI味-${stamp}.${ext}`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => { URL.revokeObjectURL(a.href) }, 1000)
}

function Chips({ c }: { c: WireCandidate }): ReactNode {
  const chips: ReactNode[] = []
  const issues = c.issues.filter((i) => i !== 'missing_numbers' && i !== 'missing_urls' && i !== 'added_numbers')
  if (c.missingNumbers.length) chips.push(<span key="mn" className="hz-chip warn" title="原稿里的这些数字在改写里找不到（任何写法都没有）">缺数字 {c.missingNumbers.join('、')}</span>)
  if (c.missingUrls.length) chips.push(<span key="mu" className="hz-chip warn" title={c.missingUrls.join('\n')}>缺链接 {c.missingUrls.length}</span>)
  if (c.addedNumbers.length) chips.push(<span key="an" className="hz-chip note" title="改写里出现了原稿没有的数字，确认不是编造">新数字 {c.addedNumbers.join('、')}</span>)
  for (const i of issues) chips.push(<span key={i} className={`hz-chip ${i === 'copy' ? 'note' : 'warn'}`}>{ISSUE_LABEL[i] ?? i}</span>)
  chips.push(<span key="cr" className="hz-chip dim" title="改写里和原稿逐字相同的比例（hz copy rate）">照抄 {Math.round(c.copyRate * 100)}%</span>)
  if (c.languageResampled) chips.push(<span key="lr" className="hz-chip dim" title="输出语言和原稿不一致，已用同样参数静默重采">语言重采 {c.languageResampled}</span>)
  if (c.keepTries > 1) chips.push(<span key="kt" className="hz-chip dim">保留重试 {c.keepTries}</span>)
  if (!c.missingNumbers.length && !c.missingUrls.length && !issues.length) chips.unshift(<span key="ok" className="hz-chip ok">数字/链接/长度检查通过</span>)
  return <div className="hz-chips">{chips}</div>
}

interface PairProps { compare: boolean; hot: string | undefined; onHot: (id: string | undefined) => void; onPick: (id: string) => void }

function UnitCard({ store, unit, index, total, s, view, pair }: { store: HumanizerStore; unit: UnitView; index: number; total: number; s: State; view: DiffView | undefined; pair: PairProps }): ReactNode {
  const [showDraft, setShowDraft] = useState(false)
  const cand = shownCandidate(unit)
  const busy = s.run !== undefined
  const running = unit.state === 'running'
  const id = String(unit.id)
  return (
    <article
      className={`hz-card ${unit.state}${pair.compare && pair.hot === id ? ' hot' : ''}`}
      data-unit={unit.id}
      data-pair={id}
      onMouseEnter={pair.compare ? () => { pair.onHot(id) } : undefined}
      onMouseLeave={pair.compare ? () => { pair.onHot(undefined) } : undefined}
      onClick={pair.compare ? (e) => { if (!(e.target as HTMLElement).closest('button') && !String(globalThis.getSelection?.() ?? '')) pair.onPick(id) } : undefined}
    >
      <header className="hz-card-head">
        <span className="hz-idx">{String(index + 1).padStart(2, '0')}</span>
        <span className="hz-card-title">第 {index + 1}/{total} 段</span>
        <span className="hz-dim">第 {unit.line} 行 · {KIND_LABEL[unit.kind] ?? unit.kind}</span>
        {view?.ratio !== undefined && unit.state === 'done' ? <span className="hz-dim">改动 {Math.round(view.ratio * 100)}%</span> : null}
        <span className="hz-grow" />
        {unit.candidates.length > 1 || (running && (s.job?.nSamples ?? 1) > 1)
          ? (
              <span className="hz-tabs" role="tablist" aria-label="候选">
                {unit.candidates.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={i === unit.chosen}
                    className={`hz-tab ${i === unit.chosen ? 'on' : ''} ${c.issues.length || c.missingNumbers.length ? 'flag' : ''}`}
                    title={`候选 ${i + 1}${i === unit.best ? '（检查得分最优）' : ''}${c.seconds ? ` · ${c.seconds} s` : ''}`}
                    disabled={running}
                    onClick={() => { void store.choose(unit.id, i) }}
                  >
                    {i + 1}{i === unit.best ? '★' : ''}
                  </button>
                ))}
                {running && unit.live ? <span className="hz-tab live">{unit.live.index + 1}…</span> : null}
              </span>
            )
          : null}
        {pair.compare ? null : <button type="button" className="hz-tool" onClick={() => { setShowDraft(!showDraft) }} aria-pressed={showDraft} title="在这张卡片里显示原文（标出删改）">原文</button>}
        <button type="button" className="hz-tool" disabled={busy || !s.job} onClick={() => { void store.regenerate(unit.id) }} title="只重写这一段（用当前的候选数）">重新生成</button>
        <button type="button" className="hz-tool" disabled={!cand} onClick={() => { if (cand) void copyText(store, cand.text, '这一段') }}>复制</button>
      </header>
      {showDraft && !pair.compare
        ? (
            <div className="hz-text hz-draft">
              {view ? <Runs runs={view.draft} cls={DRAFT_CLS} /> : unit.draft}
            </div>
          )
        : null}
      <div className={`hz-text ${running ? 'hz-live' : ''}`}>
        {running && unit.live
          ? <>{unit.live.text}<span className="hz-caret" /></>
          : view
            ? <Runs runs={view.out} cls={OUT_CLS} />
            : unit.state === 'running'
              ? <span className="hz-dim">排队中…（模型服务一次只处理一个请求）</span>
              : unit.state === 'error'
                ? <span className="hz-err">这一段出错了，可点「重新生成」</span>
                : <span className="hz-dim">{unit.draft.slice(0, 160)}{unit.draft.length > 160 ? '…' : ''}</span>}
      </div>
      {cand && !running ? <Chips c={cand} /> : null}
    </article>
  )
}

function KeepBar({ store, s, taRef }: { store: HumanizerStore; s: State; taRef: { current: HTMLTextAreaElement | null } }): ReactNode {
  const [term, setTerm] = useState('')
  const add = (): void => { store.addKeep(term); setTerm('') }
  const fromSelection = (): void => {
    const ta = taRef.current
    // In the 对比 view there is no textarea: take the page selection (inside the original).
    const sel = (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : String(globalThis.getSelection?.() ?? '')).trim()
    if (sel) store.addKeep(sel)
    else store.toast('先在草稿里选中要原样保留的文字', '')
  }
  return (
    <div className="hz-keep">
      <span className="hz-keep-label" title="名字、术语、引文等：改写时一字不改（占位符锁定，改写后逐字还原）">原样保留</span>
      {(s.info?.defaultKeep ?? []).filter((k) => !s.keep.includes(k)).map((k) => (
        <span key={`d:${k}`} className={`hz-keep-chip default ${s.draft.includes(k) ? '' : 'missing'}`} title="设置里的默认保留词：草稿中出现时总是原样保留（在「设置」里修改）">
          {k}
        </span>
      ))}
      {s.keep.map((k) => (
        <span key={k} className={`hz-keep-chip ${s.draft.includes(k) ? '' : 'missing'}`} title={s.draft.includes(k) ? '会在改写中保持原样' : '草稿里找不到这段文字（需逐字一致），不会生效'}>
          {k}
          <button type="button" aria-label={`移除 ${k}`} onClick={() => { store.removeKeep(k) }}>×</button>
        </span>
      ))}
      <input
        className="hz-keep-input"
        value={term}
        placeholder="输入后回车，例如：星火计划"
        onChange={(e) => { setTerm(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
      />
      <button type="button" className="hz-tool" onClick={fromSelection} title="把草稿里选中的文字加入原样保留">＋选中文字</button>
    </div>
  )
}

function SettingsView({ store }: { store: HumanizerStore }): ReactNode {
  const bridge = useSyncExternalStore(settingsBridge.subscribe, settingsBridge.get, settingsBridge.get)
  const [leaving, setLeaving] = useState(false)
  const back = (): void => { store.setPage('main'); void store.refreshInfo() }
  const tryBack = (): void => {
    if (bridge?.model.getSnapshot().dirty) setLeaving(true)
    else back()
  }
  const lang = bridge?.lang() ?? 'zh'
  const unsaved = bridge?.model.getSnapshot().unsaved ?? 0
  return (
    <div className="hzui hz-settings-page">
      <header className="hz-bar">
        <button type="button" className="hz-tool" onClick={tryBack}>{lang === 'en' ? '← Back' : '← 返回'}</button>
        <span className="hz-brand">{lang === 'en' ? 'Settings' : '设置'}</span>
        <span className="hz-grow" />
        {store.getSnapshot().samplesPicked
          ? <button type="button" className="hz-tool" title="本浏览器里手动选过候选数；点这里改回跟随默认候选数" onClick={() => { store.followDefaultSamples() }}>候选数跟随默认</button>
          : null}
      </header>
      <div className="hz-settings-body">
        {bridge
          ? <SettingsPage model={bridge.model} lang={lang} />
          : <p className="hz-notice">设置需要 dsh 的设置服务：请从本机地址（127.0.0.1）打开 dsh web，或在 dsh「插件」页中配置 tool-humanize。</p>}
      </div>
      {leaving && bridge ? (
        <div className="hzs">
          <Confirm
            title={lang === 'en' ? 'Unsaved changes' : '有未保存的修改'}
            body={lang === 'en' ? `${unsaved} change(s) are not saved yet.` : `有 ${unsaved} 项修改还没有保存。`}
            onClose={() => { setLeaving(false) }}
            actions={[
              { label: lang === 'en' ? 'Keep editing' : '继续编辑', onClick: () => { setLeaving(false) } },
              { label: lang === 'en' ? 'Discard' : '放弃修改', onClick: () => { bridge.model.discard(); setLeaving(false); back() } },
              { label: lang === 'en' ? 'Save and go back' : '保存并返回', kind: 'primary', onClick: () => { void bridge.model.save().then((ok) => { setLeaving(false); if (ok) back() }) } },
            ]}
          />
        </div>
      ) : null}
    </div>
  )
}

export function HumanizerPanel(): ReactNode {
  ensureStyles()
  const store = humanizerStore()
  const s = useStore(store)
  if (s.page === 'settings') return <SettingsView store={store} />
  return <HumanizerMain store={store} s={s} />
}

function HumanizerMain({ store, s }: { store: HumanizerStore; s: State }): ReactNode {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => { void store.refreshInfo() }, [store])
  useEffect(() => {
    if (!s.run) return
    const t = setInterval(() => { setNow(Date.now()) }, 500)
    return () => { clearInterval(t) }
  }, [s.run])

  const dc = count(s.draft)
  const limit = s.info?.maxChars ?? 20000
  const over = dc.chars > limit
  const units = s.job?.units ?? []
  const done = units.filter((u) => u.state === 'done').length
  const running = s.run !== undefined
  const progress = s.run && s.run.kind === 'job' && units.length ? (done + (units.some((u) => u.state === 'running') ? 0.5 : 0)) / units.length : undefined
  const docText = s.document?.text ?? ''
  const stale = s.job !== undefined && s.job.draft !== s.draft
  const cmp = comparing(s)
  const views = useUnitViews(s)
  const fullView = useDocumentView(s)
  const leftRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)
  const [hot, setHot] = useState<string | undefined>()
  const { pick } = usePairedPanes(leftRef, rightRef, cmp, [s.job, s.view, views, fullView, s.document])
  const pair: PairProps = { compare: cmp, hot, onHot: setHot, onPick: (id) => { pick(id, 'right') } }

  const go = (): void => { if (!running && s.draft.trim() && !over) void store.start() }

  return (
    <div
      className="hzui"
      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); go() } }}
    >
      <header className="hz-bar">
        <span className="hz-brand">去 AI 味</span>
        <span className="hz-dim">humanizer 改写模型 · 官方提示词与采样 · 分段 / 原样保留 / 数字检查都在插件里完成</span>
        <span className="hz-grow" />
        <span className={`hz-status ${s.health ? (s.health.ok ? 'ok' : 'bad') : ''}`} title={s.health?.message ?? ''}>
          <i />{s.info ? s.info.endpoint.replace(/^https?:\/\//, '') : '…'} · {s.health ? (s.health.ok ? '在线' : '不可用') : '检查中'}
        </span>
        <span className="hz-seg" role="group" aria-label="候选数">
          <span className="hz-seg-label">候选</span>
          {[1, 2, 3, 4].map((n) => (
            <button key={n} type="button" className={s.nSamples === n ? 'on' : ''} aria-pressed={s.nSamples === n} disabled={running} onClick={() => { store.setSamples(n) }}>{n}</button>
          ))}
        </span>
        <button type="button" className="hz-tool" aria-pressed={s.showDiff} onClick={() => { store.setShowDiff(!s.showDiff) }}>{s.showDiff ? '✓ ' : ''}显示改动</button>
        <button type="button" className="hz-tool hz-gear" aria-label="设置" title="设置（服务地址、密钥、默认值、采样参数、开关）" onClick={() => { store.setPage('settings') }}>⚙ 设置</button>
      </header>

      <section className="hz-panes">
        <article className="hz-sheet">
          <header className="hz-sheet-head">
            <span className="hz-idx">01</span>
            <h2>{cmp ? '原文' : '草稿'}</h2>
            {cmp
              ? <span className="hz-legend" aria-label="图例">{s.showDiff ? <><i className="hz-del">删改</i><i className="hz-ins">新写</i></> : null}{s.job?.keepActive.length ? <i className="hz-fact">保留</i> : null}</span>
              : <span className="hz-dim">AI 写的原稿</span>}
            <span className="hz-grow" />
            {s.job
              ? (
                  <span className="hz-seg small" role="tablist" aria-label="左栏">
                    <button type="button" role="tab" aria-selected={cmp} className={cmp ? 'on' : ''} disabled={!canCompare(s)} title={canCompare(s) ? '只读：逐段对照，红色是被删改的原文' : '草稿在改写后又改过了，重新改写后才能对比'} onClick={() => { store.setLeftMode('compare') }}>对比</button>
                    <button type="button" role="tab" aria-selected={!cmp} className={!cmp ? 'on' : ''} onClick={() => { store.setLeftMode('edit') }}>编辑</button>
                  </span>
                )
              : null}
            {cmp ? null : <span className={`hz-dim ${over ? 'hz-err' : ''}`}>{dc.units.toLocaleString('zh-CN')} 字/词 · {dc.chars.toLocaleString('zh-CN')}/{limit.toLocaleString('zh-CN')} 字符</span>}
          </header>
          {cmp
            ? <CompareView s={s} views={views} doc={fullView} hot={hot} onHot={setHot} onPick={(id) => { pick(id, 'left') }} paneRef={leftRef} />
            : (
                <textarea
                  ref={taRef}
                  className="hz-draft-input"
                  value={s.draft}
                  spellCheck={false}
                  placeholder={'把 AI 写的草稿粘贴到这里（中文或英文，纯文本或 Markdown）。\n标题、代码、表格、引用、链接行会原样保留，正文按约 350 词 / 600 字分段改写。'}
                  onChange={(e) => { store.setDraft(e.target.value) }}
                />
              )}
          <KeepBar store={store} s={s} taRef={taRef} />
          <footer className="hz-sheet-foot">
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void store.importFile(f) }}
            />
            {cmp
              ? <button type="button" className="hz-tool hz-edit" onClick={() => { store.setLeftMode('edit') }} title="回到可编辑的草稿（改动后需要重新改写才能再对比）">✎ 编辑原稿</button>
              : (
                  <>
                    <button type="button" className="hz-tool" disabled={running || s.importing} onClick={() => fileRef.current?.click()}>{s.importing ? '导入中…' : '导入 .txt/.md/.docx'}</button>
                    <button type="button" className="hz-tool" disabled={running} onClick={async () => { try { const t = await navigator.clipboard.readText(); if (t) store.setDraft(t) } catch { store.toast('浏览器不允许读取剪贴板，请直接粘贴', 'err') } }}>粘贴</button>
                    <button type="button" className="hz-tool" disabled={running || !s.draft} onClick={() => { store.clearDraft() }}>清空</button>
                  </>
                )}
            {cmp ? <span className="hz-dim">{dc.units.toLocaleString('zh-CN')} 字/词</span> : null}
            <span className="hz-grow" />
            {running
              ? <button type="button" className="hz-go stop" onClick={() => { void store.stop() }}>■ 停止</button>
              : <button type="button" className="hz-go" disabled={!s.draft.trim() || over} onClick={go} title="⌘/Ctrl + Enter">改写 →</button>}
          </footer>
        </article>

        <article className="hz-sheet">
          <header className="hz-sheet-head">
            <span className="hz-idx">02</span>
            <h2>改写</h2>
            <span className="hz-dim">像人写的</span>
            <span className="hz-grow" />
            <span className="hz-seg small" role="tablist">
              <button type="button" className={s.view === 'pieces' ? 'on' : ''} onClick={() => { store.setView('pieces') }}>分段</button>
              <button type="button" className={s.view === 'document' ? 'on' : ''} onClick={() => { store.setView('document') }}>全文</button>
            </span>
          </header>
          {s.run || s.stats
            ? (
                <div className="hz-progress">
                  <div className="hz-progress-row">
                    {s.run
                      ? <span>{s.run.kind === 'regen' ? '重新生成这一段' : `正在改写第 ${Math.min(s.run.position + 1, Math.max(1, s.run.count))}/${s.run.count || '…'} 段`}{(s.job?.nSamples ?? 1) > 1 || s.run.kind === 'regen' ? ` · 每段 ${s.run.kind === 'regen' ? s.nSamples : s.job?.nSamples} 个候选` : ''} · {Math.round((now - s.run.startedAt) / 1000)} s</span>
                      : s.stats
                        ? <span>{s.stats.cancelled ? '已停止' : '完成'} · {s.stats.requests} 次模型请求 · {s.stats.seconds} s</span>
                        : null}
                    <span className="hz-grow" />
                    {s.run ? <button type="button" className="hz-tool" onClick={() => { void store.stop() }}>取消</button> : null}
                  </div>
                  {progress !== undefined ? <progress max={1} value={progress} /> : null}
                </div>
              )
            : null}
          {s.error ? <div className="hz-notice err">{s.error}<button type="button" onClick={() => { store.clearError() }}>×</button></div> : null}
          {stale ? <div className="hz-notice">草稿在改写后又改过了；右侧仍是上一次的结果，点「改写」重新开始。</div> : null}
          {s.job && s.job.keepIgnored.length ? <div className="hz-notice">这些保留文字在草稿里找不到，已忽略：{s.job.keepIgnored.map((k) => `「${k}」`).join('、')}</div> : null}
          <div className="hz-out" ref={rightRef} data-side="right">
            {!s.job
              ? (
                  <div className="hz-empty">
                    <p className="hz-empty-title">改写会出现在这里</p>
                    <p className="hz-dim">每段写完就显示；可以为每段生成 1–4 个候选并切换，单独重新生成某一段。数字、链接、照抄率、语言逐段检查。</p>
                  </div>
                )
              : s.view === 'document'
                ? (
                    <div className="hz-text hz-full" data-pair="all">
                      {fullView ? <Runs runs={fullView.out} cls={OUT_CLS} /> : docText}
                    </div>
                  )
                : units.length === 0
                  ? <div className="hz-empty"><p className="hz-dim">没有需要改写的正文（标题、代码、表格等都原样保留）。</p></div>
                  : units.map((u, i) => <UnitCard key={u.id} store={store} unit={u} index={i} total={units.length} s={s} view={views.get(u.id)} pair={pair} />)}
          </div>
          <footer className="hz-sheet-foot">
            {s.document?.warnings.length
              ? <span className="hz-chip warn" title={s.document.warnings.join('\n')}>{s.document.warnings.length} 条提醒（悬停查看）</span>
              : s.document && s.document.done > 0 && !running ? <span className="hz-chip ok">检查未发现问题</span> : null}
            {s.job?.keepActive.length ? <span className="hz-chip fact">原样保留 {s.job.keepActive.length} 处</span> : null}
            <span className="hz-grow" />
            <span className="hz-dim">{docText ? `${count(docText).units.toLocaleString('zh-CN')} 字/词` : ''}</span>
            <button type="button" className="hz-tool" disabled={!docText || running} onClick={() => { download(docText, 'md') }}>下载 .md</button>
            <button type="button" className="hz-tool" disabled={!docText || running} onClick={() => { download(docText, 'txt') }}>下载 .txt</button>
            <button type="button" className="hz-go small" disabled={!docText || running} onClick={() => { void copyText(store, docText, '全文') }}>复制全文</button>
          </footer>
        </article>
      </section>
      {s.document?.warnings.length && !running
        ? <details className="hz-warnings"><summary>提醒（{s.document.warnings.length}）——请核对数字、人名、日期与论断方向</summary><ul>{s.document.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
        : null}
      {s.toast ? <div className={`hz-toast ${s.toast.kind}`} role="status">{s.toast.text}</div> : null}
    </div>
  )
}

export function HumanizerIcon({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h7" />
      <path d="M3 16c2-3 3.5-3 5 0s3 3 5 0 3-3 5 0 2 2 3 1" />
      <path d="M15 4l5 5-4 1-1-1z" />
    </svg>
  )
}
