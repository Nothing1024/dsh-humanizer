/**
 * CSS of the settings page. dsh design tokens first (they follow dsh's light/dark theme), with
 * currentColor mixes as the fallback so the page also reads correctly outside dsh web.
 * Responsive through a container query: rows stack when the page itself is narrow (the panel's
 * side view), regardless of the window width.
 */
const ID = 'dsh-tool-humanize/settings.css'

const CSS = `
.hzs{--hzs-line:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 12%,transparent));--hzs-dim:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 55%,transparent));--hzs-field:var(--dsw-alias-bg-layer-3,color-mix(in srgb,currentColor 4%,transparent));--hzs-card:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 2.5%,transparent));--hzs-surface:var(--dsw-alias-bg-layer-1,Canvas);--hzs-accent:var(--dsw-alias-state-business-primary,#3b82f6);--hzs-err:var(--dsw-alias-state-error-primary,#e5484d);--hzs-ok:var(--dsw-alias-state-success-primary,#18a058);--hzs-warn:var(--dsw-alias-state-warn-primary,#d38b00);--hzs-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 6%,transparent));
  container-type:inline-size;position:relative;display:flex;flex-direction:column;gap:20px;font-size:13px;line-height:20px;color:inherit;min-width:0;max-width:860px}
.hzs.has-bar{padding-bottom:4px}
.hzs *{box-sizing:border-box}
.hzs button{font:inherit;color:inherit;cursor:pointer}
.hzs button:disabled{cursor:default;opacity:.45}
.hzs :focus-visible{outline:2px solid color-mix(in srgb,var(--hzs-accent) 70%,transparent);outline-offset:1px}
.hzs code{font-size:12px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.hzs-dim{color:var(--hzs-dim);font-size:12px}
.hzs-grow{flex:1}
.hzs-err{color:var(--hzs-err)!important}
.hzs-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.hzs-intro{margin:0;display:flex;align-items:center;gap:6px;color:var(--hzs-dim)}
.hzs-notice{margin:0;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--hzs-warn) 12%,transparent)}

/* info tooltip */
.hzs-info{position:relative;display:inline-flex;align-items:center;color:var(--hzs-dim);cursor:help;border-radius:50%}
.hzs-info:hover,.hzs-info:focus{color:var(--hzs-accent)}
.hzs-tip{position:absolute;z-index:30;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);width:max-content;max-width:min(300px,70vw);padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;font-weight:400;white-space:normal;text-align:left;
  background:var(--dsw-alias-bg-tooltip,#1f2329);color:var(--dsw-alias-label-tooltip,#fff);box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:0;visibility:hidden;transition:opacity .12s;pointer-events:none}
.hzs-info:hover .hzs-tip,.hzs-info:focus .hzs-tip{opacity:1;visibility:visible}

/* cards and sections */
.hzs-card{border:.5px solid var(--hzs-line);border-radius:12px;background:var(--hzs-card)}
.hzs-section{display:flex;flex-direction:column;gap:8px}
.hzs-section-title{margin:0;font-size:13px;font-weight:600;padding-left:2px}
.hzs-section-title .hzs-dim{font-weight:400}

/* rows */
.hzs-rows{display:flex;flex-direction:column}
.hzs-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:20px;row-gap:6px;padding:12px 14px;border-top:.5px solid var(--hzs-line);min-width:0}
.hzs-rows>.hzs-row:first-child{border-top:0}
.hzs-row.wide{grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr)}
.hzs-row-text{min-width:0}
.hzs-label{display:flex;align-items:center;gap:6px;font-weight:500;line-height:20px}
.hzs-hint{margin:1px 0 0;font-size:12px;line-height:17px;color:var(--hzs-dim)}
.hzs-row-ctl{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
.hzs-row.wide .hzs-row-ctl>:first-child{flex:1;min-width:0}
.hzs-errmsg{grid-column:1/-1;margin:0;font-size:12px;line-height:17px;color:var(--hzs-err);text-align:right}
.hzs-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--hzs-accent);flex:none;margin:0 2px}
.hzs-reset,.hzs-reset-gap{width:24px;height:24px;flex:none}
.hzs-reset{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--hzs-dim)}
.hzs-reset:hover:not(:disabled){background:var(--hzs-hover);color:var(--hzs-accent)}
@container (max-width:560px){
  .hzs-row,.hzs-row.wide{grid-template-columns:minmax(0,1fr);padding:11px 12px}
  .hzs-row-ctl{justify-content:flex-start}
  .hzs-row.wide .hzs-row-ctl>:first-child,.hzs-row-ctl>.hzs-input{flex:1}
  .hzs-errmsg{text-align:left}
  .hzs-row:has(.hzs-switch){grid-template-columns:minmax(0,1fr) auto}
  .hzs-row:has(.hzs-switch) .hzs-row-ctl{justify-content:flex-end}
  .hzs-acc-hint{display:none}
}

/* inputs */
.hzs-input{width:100%;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 20%,transparent));background:var(--hzs-field);font:inherit;color:inherit;outline:none;transition:border-color .12s,box-shadow .12s}
.hzs-input:focus{border-color:var(--hzs-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--hzs-accent) 18%,transparent)}
.hzs-input[aria-invalid="true"]{border-color:var(--hzs-err);box-shadow:0 0 0 3px color-mix(in srgb,var(--hzs-err) 14%,transparent)}
.hzs-input.num{width:120px;text-align:right;font-variant-numeric:tabular-nums}
.hzs-input.num.xs{width:64px}
.hzs-num{display:flex;align-items:center;gap:6px}
.hzs-unit{color:var(--hzs-dim);font-size:12px;min-width:28px}
.hzs-num:not(:has(.hzs-unit))::after{content:"";min-width:28px}
.hzs-stepper{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 20%,transparent));border-radius:8px;background:var(--hzs-field);overflow:hidden;height:32px}
.hzs-stepper button{width:30px;height:100%;border:0;background:transparent;font-size:15px!important;line-height:1}
.hzs-stepper button:hover:not(:disabled){background:var(--hzs-hover)}
.hzs-stepper .hzs-input{width:44px;height:100%;border:0;border-radius:0;background:transparent;text-align:center;padding:0;box-shadow:none;font-variant-numeric:tabular-nums}
.hzs-stepper:focus-within{border-color:var(--hzs-accent)}
.hzs-slider{display:flex;align-items:center;gap:10px}
.hzs-slider input[type=range]{width:160px;accent-color:var(--hzs-accent)}
.hzs-seg{display:inline-flex;padding:2px;border-radius:9px;background:var(--hzs-field);border:.5px solid var(--hzs-line)}
.hzs-seg button{min-width:40px;height:28px;border:0;border-radius:7px;background:transparent;font-variant-numeric:tabular-nums;font-weight:500;color:var(--hzs-dim)!important}
.hzs-seg button:hover:not(:disabled):not(.on){color:inherit!important}
.hzs-seg button.on{background:var(--hzs-surface);color:inherit!important;box-shadow:0 1px 2px rgba(0,0,0,.12),0 0 0 .5px var(--hzs-line)}
.hzs-switch{position:relative;display:inline-flex;align-items:center;background:none;border:0;padding:2px 0}
.hzs-switch i{width:36px;height:20px;border-radius:10px;background:color-mix(in srgb,currentColor 22%,transparent);position:relative;transition:background .15s}
.hzs-switch i:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.hzs-switch.on i{background:var(--hzs-accent)}
.hzs-switch.on i:after{left:18px}
.hzs-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:32px;padding:4px 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 20%,transparent));background:var(--hzs-field);cursor:text}
.hzs-chips:focus-within{border-color:var(--hzs-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--hzs-accent) 18%,transparent)}
.hzs-chips input{flex:1;min-width:120px;height:22px;border:0;background:transparent;outline:none;font:inherit;color:inherit;padding:0 4px}
.hzs-chip{display:inline-flex;align-items:center;gap:2px;height:22px;padding:0 2px 0 8px;border-radius:6px;background:color-mix(in srgb,var(--hzs-accent) 13%,transparent);font-size:12.5px}
.hzs-chip button{width:18px;height:18px;border:0;border-radius:4px;background:transparent;line-height:1;color:var(--hzs-dim)!important}
.hzs-chip button:hover{background:color-mix(in srgb,currentColor 12%,transparent);color:inherit!important}

/* buttons, badges */
.hzs-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 22%,transparent));background:var(--hzs-surface);font-size:12.5px!important;white-space:nowrap}
.hzs-btn:hover:not(:disabled){background:var(--hzs-hover)}
.hzs-btn.ghost{border-color:transparent;background:transparent;color:var(--hzs-accent)!important}
.hzs-btn.ghost.danger,.hzs-btn.danger-ghost{color:var(--hzs-err)!important;background:transparent;border-color:transparent;font-weight:400}
.hzs-btn.ghost.danger:hover:not(:disabled),.hzs-btn.danger-ghost:hover:not(:disabled){background:color-mix(in srgb,var(--hzs-err) 10%,transparent)}
.hzs-btn.danger-ghost{background:transparent}
.hzs-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--hzs-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)!important;font-weight:500}
.hzs-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--hzs-accent)))}
.hzs-btn.danger{background:var(--hzs-err);border-color:transparent;color:#fff!important;font-weight:500}
.hzs-btn kbd{font:inherit;font-size:11px;opacity:.65;padding:0 4px;border-radius:4px;background:color-mix(in srgb,currentColor 16%,transparent)}
.hzs-link{background:none;border:0;padding:0;font-size:12px!important;color:var(--hzs-accent)!important}
.hzs-badge{display:inline-flex;align-items:center;font-size:11.5px;line-height:18px;padding:0 7px;border-radius:9px;background:color-mix(in srgb,currentColor 8%,transparent);color:var(--hzs-dim);font-weight:500;white-space:nowrap}
.hzs-badge.ok{background:color-mix(in srgb,var(--hzs-ok) 14%,transparent);color:var(--hzs-ok)}
.hzs-badge.bad{background:color-mix(in srgb,var(--hzs-err) 12%,transparent);color:var(--hzs-err)}
.hzs-badge.warn{background:color-mix(in srgb,var(--hzs-warn) 15%,transparent);color:var(--hzs-warn)}

/* connection card */
.hzs-conn{display:flex;flex-direction:column}
.hzs-conn-head{display:flex;align-items:center;gap:12px;padding:14px;flex-wrap:wrap}
.hzs-led{width:10px;height:10px;border-radius:50%;flex:none;background:color-mix(in srgb,currentColor 25%,transparent)}
.hzs-led.ok{background:var(--hzs-ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--hzs-ok) 18%,transparent)}
.hzs-led.warn{background:var(--hzs-warn);box-shadow:0 0 0 4px color-mix(in srgb,var(--hzs-warn) 18%,transparent)}
.hzs-led.bad{background:var(--hzs-err);box-shadow:0 0 0 4px color-mix(in srgb,var(--hzs-err) 16%,transparent)}
.hzs-led.checking{background:var(--hzs-accent);animation:hzs-pulse 1s ease-in-out infinite}
@keyframes hzs-pulse{50%{opacity:.35}}
.hzs-conn-id{min-width:0;flex:1 1 220px}
.hzs-conn-host{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px}
.hzs-conn-state{font-size:12px;line-height:18px}
.hzs-conn-state.ok{color:var(--hzs-ok)}
.hzs-conn-state.warn{color:var(--hzs-warn)}
.hzs-conn-state.bad{color:var(--hzs-err)}
.hzs-conn-state.idle,.hzs-conn-state.checking{color:var(--hzs-dim)}
.hzs-conn-actions{display:flex;gap:6px;align-items:center}
.hzs-conn-edit{border-top:.5px solid var(--hzs-line)}
.hzs-conn-key{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:.5px solid var(--hzs-line);flex-wrap:wrap;min-height:48px}
.hzs-conn-label{font-weight:500}
.hzs-ref{overflow:hidden;text-overflow:ellipsis;max-width:220px}
.hzs-keyedit{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0 14px 12px}
.hzs-keyedit .hzs-hint{flex-basis:100%;display:flex;align-items:center;gap:4px}
.hzs-pw{position:relative;flex:1;min-width:200px}
.hzs-pw .hzs-input{padding-right:56px}
.hzs-pw-eye{position:absolute;right:4px;top:4px;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;font-size:12px!important;color:var(--hzs-accent)!important}
.hzs-pw-eye:hover{background:var(--hzs-hover)}
.hzs-conn-more{padding:0 14px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.hzs-conn-more .hzs-probe{align-self:stretch}
.hzs-probe{list-style:none;margin:0;padding:8px 10px;border-radius:8px;background:var(--hzs-field);display:flex;flex-direction:column;gap:2px;font-size:12px}
.hzs-probe li.ok b{color:var(--hzs-ok)}
.hzs-probe li.bad b{color:var(--hzs-err)}
.hzs-probe li.warn{color:var(--hzs-warn)}

/* advanced accordions */
.hzs-adv{display:flex;flex-direction:column;border:.5px solid var(--hzs-line);border-radius:12px;background:var(--hzs-card);overflow:hidden}
.hzs-acc+.hzs-acc{border-top:.5px solid var(--hzs-line)}
.hzs-acc-head{width:100%;display:flex;align-items:center;gap:8px;padding:12px 14px;border:0;background:transparent;text-align:left}
.hzs-acc-head:hover{background:var(--hzs-hover)}
.hzs-chev{flex:none;color:var(--hzs-dim);transition:transform .15s}
.hzs-acc.open .hzs-chev{transform:rotate(90deg)}
.hzs-acc-title{font-weight:500;display:inline-flex;align-items:center;gap:2px;white-space:nowrap}
.hzs-acc-hint{color:var(--hzs-dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.hzs-acc-body{border-top:.5px solid var(--hzs-line);background:color-mix(in srgb,var(--hzs-surface) 50%,transparent)}
.hzs-acc-body .hzs-row{padding-left:36px}
@container (max-width:560px){.hzs-acc-body .hzs-row{padding-left:14px}}
.hzs-warn{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 14px 2px;padding:9px 12px;border-radius:8px;font-size:12px;line-height:18px;background:color-mix(in srgb,var(--hzs-warn) 12%,transparent);border:.5px solid color-mix(in srgb,var(--hzs-warn) 40%,transparent)}
.hzs-warn span{flex:1 1 240px}
.hzs-resetall{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 2px 0}
.hzs-resetall .hzs-btn{padding:0 4px}

/* unsaved bar, toast, dialog */
.hzs-bar{position:sticky;bottom:12px;z-index:20;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:12px;background:var(--hzs-surface);border:.5px solid var(--hzs-line);box-shadow:0 8px 28px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);animation:hzs-rise .16s ease-out}
.hzs-bar-dot{width:8px;height:8px;border-radius:50%;background:var(--hzs-accent);flex:none}
.hzs-bar-dot.bad{background:var(--hzs-err)}
.hzs-bar-text{font-weight:500;min-width:0}
@keyframes hzs-rise{from{transform:translateY(8px);opacity:0}}
.hzs-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1000;padding:8px 14px;border-radius:10px;font-size:13px;background:var(--dsw-alias-bg-tooltip,#1f2329);color:var(--dsw-alias-label-tooltip,#fff);box-shadow:0 8px 28px rgba(0,0,0,.22);animation:hzs-rise .16s ease-out}
.hzs-toast.error{background:var(--hzs-err);color:#fff}
.hzs-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.32)}
.hzs-dialog{width:min(400px,100%);padding:20px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 20px 60px rgba(0,0,0,.3);font-size:13px;line-height:20px}
.hzs-dialog h3{margin:0 0 6px;font-size:15px;font-weight:600}
.hzs-dialog p{margin:0 0 18px;color:var(--dsw-alias-label-secondary,inherit)}
.hzs-dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.hzs-dialog .hzs-btn{height:32px;padding:0 14px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 22%,transparent));background:transparent;font:inherit;color:inherit;cursor:pointer}
.hzs-dialog .hzs-btn.primary{background:var(--dsw-alias-button-primary-fill,#3b82f6);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.hzs-dialog .hzs-btn.danger{background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent;color:#fff}
`

export function ensureSettingsStyles(): void {
  if (typeof document === 'undefined') return
  let el = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${ID}"]`)
  if (!el) {
    el = document.createElement('style')
    el.dataset.plugin = 'dsh-tool-humanize'
    el.dataset.pluginCss = ID
    document.head.appendChild(el)
  }
  if (el.textContent !== CSS) el.textContent = CSS
}
