/**
 * Panel CSS, injected once as <style data-plugin="dsh-tool-humanize">. Colours echo the official
 * app's "graphite + highlighter" look (the only colour is the yellow-green highlighter for newly
 * written words); neutrals derive from the dsh theme's text colour so light and dark both work.
 */
const CSS = `
.hzui{--hz-line:color-mix(in srgb,currentColor 14%,transparent);--hz-line2:color-mix(in srgb,currentColor 8%,transparent);--hz-dim:color-mix(in srgb,currentColor 55%,transparent);--hz-sheet:color-mix(in srgb,currentColor 3%,transparent);--hz-hl:rgba(205,245,75,.55);--hz-hl-edge:rgba(150,190,20,.9);--hz-del:#e5484d;--hz-del-bg:rgba(229,72,77,.13);--hz-del-edge:rgba(214,40,46,.85);--hz-del-ink:color-mix(in srgb,#c8282d 55%,currentColor);--hz-fact:rgba(47,111,235,.16);--hz-fact-edge:rgba(47,111,235,.65);--hz-ok:#18a058;--hz-warn:#d38b00;--hz-err:#e5484d;
  display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:12px 16px 14px;gap:10px;font-size:14px;line-height:1.5;position:relative;overflow:hidden}
@media (prefers-color-scheme:dark){.hzui{--hz-hl:rgba(205,245,75,.22);--hz-hl-edge:rgba(205,245,75,.6);--hz-del-bg:rgba(255,99,104,.2);--hz-del-edge:rgba(255,120,124,.9);--hz-del-ink:color-mix(in srgb,#ff8a8d 60%,currentColor)}}
:root[data-theme="dark"] .hzui,.dark .hzui{--hz-hl:rgba(205,245,75,.22);--hz-hl-edge:rgba(205,245,75,.6);--hz-del-bg:rgba(255,99,104,.2);--hz-del-edge:rgba(255,120,124,.9);--hz-del-ink:color-mix(in srgb,#ff8a8d 60%,currentColor)}
:root[data-theme="light"] .hzui{--hz-hl:rgba(205,245,75,.55);--hz-hl-edge:rgba(150,190,20,.9);--hz-del-bg:rgba(229,72,77,.13);--hz-del-edge:rgba(214,40,46,.85);--hz-del-ink:color-mix(in srgb,#c8282d 55%,currentColor)}
.hzui *{box-sizing:border-box}
.hzui button{font:inherit;color:inherit;cursor:pointer}
.hzui button:disabled{cursor:default;opacity:.45}
.hz-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hz-brand{font-weight:700;font-size:17px;letter-spacing:.02em}
.hz-dim{color:var(--hz-dim);font-size:12.5px}
.hz-grow{flex:1}
.hz-err{color:var(--hz-err)!important}
.hz-status{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--hz-dim)}
.hz-status i{width:8px;height:8px;border-radius:50%;background:var(--hz-dim);display:inline-block}
.hz-status.ok i{background:var(--hz-ok)}.hz-status.bad i{background:var(--hz-err)}
.hz-seg{display:inline-flex;align-items:center;border:1px solid var(--hz-line);border-radius:9px;overflow:hidden}
.hz-seg-label{padding:0 8px;font-size:12px;color:var(--hz-dim)}
.hz-seg button{border:0;background:transparent;padding:3px 10px;font-size:13px;border-left:1px solid var(--hz-line2)}
.hz-seg button.on{background:color-mix(in srgb,currentColor 12%,transparent);font-weight:600}
.hz-seg.small button{padding:2px 9px;font-size:12px}
.hz-tool{border:1px solid var(--hz-line);background:transparent;border-radius:8px;padding:3px 9px;font-size:12.5px;white-space:nowrap}
.hz-tool:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}
.hz-tool[aria-pressed="true"]{background:color-mix(in srgb,currentColor 10%,transparent)}
.hzui .hz-go{border:0;border-radius:10px;padding:6px 16px;font-weight:650;background:#101216;color:#d7f75b}
.hzui .hz-go.small{padding:4px 12px;font-size:13px}
.hzui .hz-go.stop{background:var(--hz-err);color:#fff}
.hzui .hz-go:disabled{opacity:.4}
@media (prefers-color-scheme:dark){.hzui .hz-go{background:#cdf54b;color:#0a0b0d}}
:root[data-theme="dark"] .hzui .hz-go{background:#cdf54b;color:#0a0b0d}
.hz-panes{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
@media (max-width:900px){.hz-panes{grid-template-columns:1fr;grid-template-rows:minmax(260px,1fr) minmax(320px,1.3fr);overflow:auto}}
.hz-sheet{display:flex;flex-direction:column;min-height:0;border:1px solid var(--hz-line);border-radius:16px;background:var(--hz-sheet);overflow:hidden}
.hz-sheet-head{display:flex;align-items:baseline;gap:8px;padding:10px 14px 8px;border-bottom:1px solid var(--hz-line2)}
.hz-sheet-head h2{margin:0;font-size:15px;font-weight:650}
.hz-idx{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--hz-dim)}
.hz-sheet-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--hz-line2);flex-wrap:wrap}
.hz-draft-input{flex:1;min-height:0;resize:none;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1.75;padding:12px 16px}
.hz-keep{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px;border-top:1px dashed var(--hz-line)}
.hz-keep-label{font-size:12.5px;font-weight:600;padding-right:2px}
.hz-keep-chip{display:inline-flex;align-items:center;gap:4px;background:var(--hz-fact);box-shadow:inset 0 -1.5px 0 var(--hz-fact-edge);border-radius:6px;padding:1px 4px 1px 7px;font-size:12.5px}
.hz-keep-chip.missing{opacity:.55;text-decoration:line-through}
.hz-keep-chip button{border:0;background:transparent;padding:0 3px;font-size:13px;line-height:1}
.hz-keep-input{flex:1;min-width:140px;border:1px solid var(--hz-line);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:3px 8px}
.hz-progress{padding:8px 14px;border-bottom:1px solid var(--hz-line2);font-size:12.5px}
.hz-progress-row{display:flex;align-items:center;gap:8px}
.hz-progress progress{width:100%;height:4px;margin-top:6px;accent-color:#a3c82a}
.hz-notice{margin:8px 12px 0;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--hz-warn) 14%,transparent);font-size:12.5px;display:flex;gap:8px;align-items:flex-start}
.hz-notice.err{background:color-mix(in srgb,var(--hz-err) 16%,transparent)}
.hz-notice button{margin-left:auto;border:0;background:transparent}
.hz-out{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.hz-empty{margin:auto;text-align:center;max-width:380px;padding:30px 10px}
.hz-empty-title{font-weight:650;font-size:15px;margin:0 0 6px}
.hz-card{border:1px solid var(--hz-line2);border-radius:12px;padding:8px 12px 10px;background:color-mix(in srgb,currentColor 2%,transparent)}
.hz-card.running{border-color:var(--hz-hl-edge);box-shadow:0 0 0 2px color-mix(in srgb,var(--hz-hl-edge) 25%,transparent)}
.hz-card.pending{opacity:.6}
.hz-card.error{border-color:var(--hz-err)}
.hz-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.hz-card-title{font-weight:600;font-size:13px}
.hz-tabs{display:inline-flex;gap:3px}
.hz-tab{border:1px solid var(--hz-line);background:transparent;border-radius:6px;min-width:28px;padding:1px 6px;font-size:12px}
.hz-tab.on{background:var(--hz-hl);border-color:var(--hz-hl-edge);font-weight:650}
.hz-tab.flag{box-shadow:inset 0 -2px 0 var(--hz-warn)}
.hz-tab.live{opacity:.7;border-style:dashed}
.hz-text{white-space:pre-wrap;word-break:break-word;font-size:15px;line-height:1.75}
.hz-draft{font-size:13.5px;color:var(--hz-dim);border-left:3px solid var(--hz-line);padding:2px 0 2px 10px;margin-bottom:8px}
.hz-full{padding:4px 6px}
.hz-ins{background:var(--hz-hl);box-shadow:inset 0 -1px 0 var(--hz-hl-edge);border-radius:2px}
.hz-del{background:var(--hz-del-bg);color:var(--hz-del-ink);text-decoration:line-through;text-decoration-color:var(--hz-del-edge);text-decoration-thickness:1.5px;border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.hz-out{position:relative}
.hz-cmp .hz-text{font-size:15px}
.hz-orig{cursor:pointer}
.hz-card.hot{border-color:color-mix(in srgb,var(--hz-fact-edge) 70%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--hz-fact-edge) 18%,transparent)}
.hz-card.flash{animation:hz-flash .9s ease-out}
@keyframes hz-flash{0%{box-shadow:0 0 0 4px color-mix(in srgb,var(--hz-fact-edge) 45%,transparent)}100%{box-shadow:0 0 0 0 transparent}}
.hz-orig.pending .hz-text,.hz-orig.running .hz-text{color:var(--hz-dim)}
.hz-legend{display:inline-flex;gap:8px;align-items:center;font-size:12px}
.hz-legend i{font-style:normal;padding:0 4px;line-height:18px}
.hz-edit{font-weight:600}
.hz-fact{background:var(--hz-fact);box-shadow:inset 0 -1.5px 0 var(--hz-fact-edge);border-radius:2px}
.hz-num{outline:1.5px dashed var(--hz-warn);outline-offset:1px;border-radius:2px}
.hz-live{opacity:.85}
.hz-caret{display:inline-block;width:7px;height:1.1em;vertical-align:text-bottom;background:var(--hz-hl-edge);margin-left:1px;animation:hzblink 1s steps(1) infinite}
@keyframes hzblink{50%{opacity:0}}
.hz-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.hz-chip{font-size:11.5px;border-radius:999px;padding:1px 8px;border:1px solid var(--hz-line);white-space:nowrap}
.hz-chip.ok{color:var(--hz-ok);border-color:color-mix(in srgb,var(--hz-ok) 45%,transparent)}
.hz-chip.warn{color:var(--hz-warn);border-color:color-mix(in srgb,var(--hz-warn) 55%,transparent);background:color-mix(in srgb,var(--hz-warn) 8%,transparent)}
.hz-chip.note{color:var(--hz-dim)}
.hz-chip.dim{color:var(--hz-dim);border-color:var(--hz-line2)}
.hz-chip.fact{background:var(--hz-fact);border-color:var(--hz-fact-edge)}
.hz-warnings{font-size:12.5px;border:1px solid color-mix(in srgb,var(--hz-warn) 45%,transparent);border-radius:10px;padding:6px 12px;max-height:22vh;overflow:auto}
.hz-warnings ul{margin:6px 0 0;padding-left:18px}
.hz-toast{position:absolute;left:50%;top:52px;transform:translateX(-50%);background:#101216;color:#f6f7f9;border-radius:10px;padding:7px 14px;font-size:13px;box-shadow:0 12px 30px -12px rgba(0,0,0,.5);z-index:5}
.hz-toast.ok{background:#14532d}.hz-toast.err{background:#7f1d1d}
.hz-keep-chip.default{background:transparent;outline:1px dashed var(--hz-fact-edge);outline-offset:-1px;padding-right:7px}
.hz-settings-page{overflow:hidden}
.hz-settings-body{flex:1;min-height:0;overflow:auto;padding:4px 4px 0 2px}
.hz-settings-body .hzs{max-width:1100px}
`

const ID = 'dsh-tool-humanize/panel.css'

export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-tool-humanize'
  tag.dataset.pluginCss = ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

export const PANEL_CSS = CSS
