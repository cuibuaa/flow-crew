import {activityNotices, commandLimit} from '../rewrite-src/contract/status.mjs';
import type {} from '../rewrite-src/host/activity.js';
import type { RunStatusFile, RunStageStatus, StageSegment } from '../rewrite-src/contract/runtime.js';

export const styles = `
/* v4: graphics carry the facts, words only where a picture cannot. One track per run = plan progress + where the time went. */
:root{
  color-scheme:dark;
  /* palette from codex round 2: deep navy ground, frosted panels, pastel state colours */
  --bg:#0d1723; --glass:rgba(24,32,43,.74); --well:rgba(255,255,255,.03); --code:rgba(11,19,29,.4);
  --line:rgba(255,255,255,.19); --line-2:rgba(255,255,255,.11); --hi:rgba(255,255,255,.05);
  --ink:#f0f2f5; --muted:#a7b5c8; --faint:#7f93ac;
  --primary:#eff4fa; --on-primary:#17202c;
  --run:#aacdff; --wait:#edc79d; --ok:#a1d8cc; --bad:#eba8a8; --idle:#7f93ac; --dlv:#a7b5c8; --violet:#c1b5e7;
  --run-s:rgba(170,205,255,.15); --wait-s:rgba(237,199,157,.15); --ok-s:rgba(161,216,204,.15); --bad-s:rgba(235,168,168,.15); --idle-s:rgba(127,147,172,.10); --dlv-s:rgba(167,181,200,.12);
  --blob-a:rgba(74,119,127,.28); --blob-b:rgba(76,87,156,.22); --blob-c:rgba(118,96,141,.15);
  --shadow:0 18px 65px rgba(0,0,0,.17); --hatch:rgba(255,255,255,.14); --tip:rgba(13,23,35,.96);
  --font:system-ui,"Segoe UI","Microsoft YaHei",-apple-system,sans-serif;
  --mono:ui-monospace,Consolas,"SF Mono",Menlo,monospace;
  --node:20px; --stub:40px;
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#e7edf2; --glass:rgba(255,255,255,.67); --well:rgba(255,255,255,.31); --code:rgba(205,218,229,.18);
  --line:rgba(36,62,85,.19); --line-2:rgba(36,62,85,.10); --hi:rgba(255,255,255,.7);
  --ink:#1d2a38; --muted:#526579; --faint:#63778b;
  --primary:#24364a; --on-primary:#ffffff;
  --run:#3e6399; --wait:#8e5b23; --ok:#267463; --bad:#9c4646; --idle:#63778b; --dlv:#526579; --violet:#725f9b;
  --run-s:rgba(62,99,153,.12); --wait-s:rgba(142,91,35,.13); --ok-s:rgba(38,116,99,.12); --bad-s:rgba(156,70,70,.12); --idle-s:rgba(99,119,139,.09); --dlv-s:rgba(82,101,121,.10);
  --blob-a:rgba(74,119,127,.10); --blob-b:rgba(76,87,156,.08); --blob-c:rgba(118,96,141,.06);
  --shadow:0 18px 65px rgba(66,89,109,.06); --hatch:rgba(36,62,85,.16); --tip:rgba(29,42,56,.95);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 var(--font);-webkit-font-smoothing:antialiased}
.backdrop{position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:radial-gradient(ellipse at 90% 5%,var(--blob-a),transparent 53%),
    radial-gradient(ellipse at 2% 54%,var(--blob-b),transparent 52%),
    radial-gradient(ellipse at 85% 98%,var(--blob-c),transparent 45%)}
.wrap{max-width:1120px;margin:0 auto;padding-block:24px 56px;
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));
  display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}
.i{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.glass{background:var(--glass);-webkit-backdrop-filter:blur(26px);backdrop-filter:blur(26px);
  border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow),inset 0 1px 0 var(--hi)}
.s-ok{--x:var(--ok);--xs:var(--ok-s)} .s-run{--x:var(--run);--xs:var(--run-s)} .s-wait{--x:var(--wait);--xs:var(--wait-s)}
.s-bad{--x:var(--bad);--xs:var(--bad-s)} .s-idle,.s-off{--x:var(--idle);--xs:var(--idle-s)} .s-dlv{--x:var(--dlv);--xs:var(--dlv-s)}
button{font:inherit;cursor:pointer;color:inherit}
:focus-visible{outline:2px solid var(--run);outline-offset:2px}

/* header */
.top{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px}
.brand{display:flex;align-items:center;gap:9px;margin-right:6px}
.brand h1{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.logo{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:var(--well);border:1px solid var(--line)}
.logo .i{width:18px;height:18px}
.sum{display:flex;flex-wrap:wrap;gap:6px}
.sum a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--ink);padding:4px 11px 4px 6px;border-radius:999px;
  border:1px solid var(--line);background:var(--glass);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);font-variant-numeric:tabular-nums}
.sum a b{font-size:15px;font-weight:650}
.sum .lb{font-size:12.5px;color:var(--muted);white-space:nowrap}
.sum a.s-wait .lb{color:var(--wait)}
.sum .ic{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;color:var(--x);background:var(--xs)}
.sum .ic .i{width:12px;height:12px}
.sum a.s-wait{border-color:color-mix(in srgb,var(--wait) 45%,var(--line))}
.sum a.s-wait .ic{animation:ring 2.2s ease-out infinite}
@keyframes ring{0%{box-shadow:0 0 0 0 var(--wait-s)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.tools{margin-left:auto;display:flex;align-items:center;gap:8px}
.tools .live{width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:4px;animation:pulse 2.4s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--ok-s)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.mock{font-size:11.5px;color:var(--muted);border:1px dashed var(--line);border-radius:999px;padding:2px 9px}
.iconbtn{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line);background:var(--well);color:var(--muted);padding:0}
.iconbtn:hover{color:var(--ink);border-color:var(--muted)}
.iconbtn .i{width:15px;height:15px}
.legend{position:absolute;right:0;top:calc(100% + 10px);z-index:20;width:min(360px,100%);padding:16px 18px;border-radius:18px;display:grid;gap:10px;font-size:13px}
.legend h3{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.lg{display:grid;grid-template-columns:28px 1fr;gap:7px 10px;align-items:center}
.lg .sw{display:grid;place-items:center}
.legend p{margin:0;color:var(--muted);font-size:12.5px}

/* run card */
.run{padding:18px 20px 16px;display:grid;gap:12px;grid-template-columns:minmax(0,1fr);scroll-margin-top:16px}
.run.s-wait{border-color:color-mix(in srgb,var(--wait) 40%,var(--line));box-shadow:var(--shadow),inset 0 1px 0 var(--hi),0 0 0 1px color-mix(in srgb,var(--wait) 18%,transparent),0 0 34px -6px var(--wait-s)}
.r1{display:flex;align-items:center;gap:10px;min-width:0}
.r1 h2,.r1 h3{margin:0;font-size:18px;font-weight:640;letter-spacing:-.01em;min-width:0;text-wrap:balance}
.r1 h3{font-size:15px;font-weight:600}
.badge{width:26px;height:26px;border-radius:50%;flex:none;display:grid;place-items:center;color:var(--x);background:var(--xs);border:1px solid color-mix(in srgb,var(--x) 40%,transparent)}
.badge .i{width:13px;height:13px}
.tag{font-size:11px;border:1px dashed var(--line);color:var(--muted);border-radius:999px;padding:1px 8px;flex:none}
.fresh{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.more-btn .i{transition:transform .2s}
.more-btn[aria-expanded="true"] .i{transform:rotate(180deg)}

/* the track: a node per planned stage, segment length = real time, future stages as short dashed stubs */
.trackrow{display:flex;align-items:center;gap:12px;min-width:0}
.bar{flex:1;display:flex;align-items:center;gap:3px;min-width:0;height:24px}
.stg{display:flex;align-items:center;min-width:0}
.stg.fut{flex:0 0 auto}
.node{flex:none;width:var(--node);height:var(--node);border-radius:50%;display:grid;place-items:center;z-index:1;
  color:var(--x);background:color-mix(in srgb,var(--bg) 84%,var(--x));border:1.5px solid var(--x)}
.node.sq{border-radius:6px}
.node .i{width:11px;height:11px;stroke-width:2.4}
.stg.s-idle .node{background:transparent;border:1.5px dashed var(--line);color:var(--faint)}
.stg.cur .node{box-shadow:0 0 0 4px var(--xs)}
.stg.cur.s-run .node{animation:breathe 1.8s ease-in-out infinite}
@keyframes breathe{50%{box-shadow:0 0 0 7px var(--xs)}}
.parts{flex:1;display:flex;gap:2px;height:12px;margin-left:-3px;min-width:0}
.p{position:relative;min-width:3px;border-radius:3px;background:color-mix(in srgb,var(--x) 32%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--x) 50%,transparent);display:grid;place-items:center}
.p.gap{background:repeating-linear-gradient(135deg,var(--hatch) 0 3px,transparent 3px 6px);outline:1px dashed var(--line);outline-offset:-1px}
.p.x{min-width:12px}
.p.x .i{width:8px;height:8px;stroke:var(--x);stroke-width:2.6}
.p.live{height:9px;margin-right:4px;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--x) 55%,transparent) 0 6px,color-mix(in srgb,var(--x) 16%,transparent) 6px 12px);background-size:17px 17px;animation:slide 1.4s linear infinite}
@keyframes slide{to{background-position:17px 0}}
.stub{width:var(--stub);border-top:2px dashed var(--line);margin-left:-2px}
.total{font-size:13px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.under{min-height:20px;font-size:13.5px}
.ul{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
.curlab{font-weight:620;color:var(--x)}
.curlab b{font-weight:500;color:var(--muted);margin-left:4px;font-variant-numeric:tabular-nums}
.checks{display:inline-flex;gap:3px;flex-wrap:wrap}
.ck{width:9px;height:9px;border-radius:2.5px;border:1px solid var(--line)}
.ck.s-ok{background:var(--ok);opacity:.8;border-color:transparent}
.ck.s-run{background:var(--run);border-color:transparent;animation:blink 1.2s ease-in-out infinite}
@keyframes blink{50%{opacity:.35}}
.ckg{display:inline-flex;align-items:center;gap:8px}
.ckn{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}

.r3{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.status{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:560;color:var(--ink)}
.status .i{color:var(--x)}
.goto{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.goto .i{color:var(--muted)}
.own{display:inline-flex;color:var(--muted)}

/* ended rows */
.label{margin:6px 4px -4px;font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
.row{padding:12px 16px;border-radius:18px;display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}
.row .r1{flex-wrap:wrap}
.bar.mini{flex:1 1 220px;height:12px;gap:2px;order:0}
.bar.mini .parts{height:6px;margin:0}
.row .fresh{margin-left:0}

/* details */
.more-body{display:grid;gap:16px;padding-top:4px;border-top:1px solid var(--line-2);padding-block:14px 2px}
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--faint);font-size:11px;letter-spacing:.07em;text-transform:uppercase;padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;white-space:nowrap;border-bottom:1px solid var(--line-2);vertical-align:top;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td.nm{white-space:nowrap}
td.nm .in{display:flex;gap:9px;align-items:flex-start}
td.nm .node{--node:18px;margin-top:1px}
td.nm b{font-weight:580;display:block}
td.nm small{color:var(--faint);font-size:11.5px}
td.res{min-width:260px;color:var(--muted);white-space:normal}
.tally{display:inline-flex;gap:3px;color:var(--x);padding-top:3px}
.tally .i{width:12px;height:12px;stroke-width:2.4}
.h3{margin:0 0 8px;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.why{display:grid;gap:6px;margin:0;padding:0;list-style:none;font-size:13.5px}
.why li{display:flex;gap:9px;align-items:flex-start}
.why .i{margin-top:3px;color:var(--muted)}
.cols{display:grid;gap:16px 28px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.ubar{display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--line-2)}
.ubar i{display:block;height:100%}
.ubar .c{background:color-mix(in srgb,var(--run) 45%,transparent)} .ubar .f{background:var(--violet)}
.ukey{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--muted);margin-top:8px;font-variant-numeric:tabular-nums}
.ukey i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.ukey i.c{background:color-mix(in srgb,var(--run) 45%,transparent)} .ukey i.f{background:var(--violet)}
.ukey b{color:var(--ink);font-weight:600}
.meter{display:grid;gap:5px;font-size:12.5px;margin-bottom:10px}
.meter .rw{display:flex;justify-content:space-between;gap:10px;color:var(--muted)}
.meter .rw b{color:var(--ink);font-variant-numeric:tabular-nums}
.pips{display:flex;gap:4px}
.pips i{flex:1;height:7px;border-radius:99px;background:var(--line-2)}
.pips i.on{background:var(--x)}
.note{font-size:12px;color:var(--faint);margin:6px 0 0}

.tip{position:fixed;z-index:50;max-width:280px;padding:7px 10px;border-radius:10px;background:var(--tip);color:#eef2f6;font-size:12.5px;line-height:1.4;
  border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:none}

@media (max-width:560px){
  :root{--node:16px;--stub:10px}
  .run{padding:15px 15px 13px;border-radius:20px}
  .r1 h2{font-size:16.5px}
  .p.x{min-width:9px}
  .brand h1{font-size:17px}
  .sum{order:3;width:100%}
  .sum a{padding:3px 9px 3px 5px;gap:5px}
  .sum .lb{font-size:12px}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}

[hidden]{display:none!important}.store{display:contents}.run,.row{min-width:0}.r1 h2,.r1 h3{overflow-wrap:anywhere}.r1 h2,.r1 h3{flex:1}.fresh{margin-left:0}.iconbtn{flex:none}.more-body{overflow:hidden}.why span{overflow-wrap:anywhere}.cols{grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))}.poll-down{background:var(--idle);animation:none}.unknown-state{font-size:12px;color:var(--muted)}
.row h3{flex:0 1 auto}.row .more-btn{margin-left:auto}

`;

export const symbols = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="i-ok" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></symbol>
    <symbol id="i-dlv" viewBox="0 0 16 16"><path d="M8 2.6l5.4 5.4L8 13.4 2.6 8z"/></symbol>
    <symbol id="i-run" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/></symbol>
    <symbol id="i-wait" viewBox="0 0 16 16"><path d="M6 4.5v7M10 4.5v7"/></symbol>
    <symbol id="i-bad" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></symbol>
    <symbol id="i-off" viewBox="0 0 16 16"><rect x="4.8" y="4.8" width="6.4" height="6.4" rx="1.2" fill="currentColor" stroke="none"/></symbol>
    <symbol id="i-hand" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.8M8 11.1v.1"/></symbol>
    <symbol id="i-pulse" viewBox="0 0 16 16"><path d="M1.5 8.5h3l1.6-4 2.6 8 1.8-5 1 1h3"/></symbol>
    <symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7"/></symbol>
    <symbol id="i-chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></symbol>
    <symbol id="i-bell" viewBox="0 0 16 16"><path d="M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1.2 1.2H2.8zM6.6 14h2.8"/></symbol>
    <symbol id="i-belloff" viewBox="0 0 16 16"><path d="M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1.2 1.2H2.8zM6.6 14h2.8M2.5 2.5l11 11"/></symbol>
    <symbol id="i-arrow" viewBox="0 0 16 16"><path d="M3 8h9.5M9 4.5L12.5 8 9 11.5"/></symbol>
    <symbol id="i-help" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3M8 11.3v.1"/></symbol>
    <symbol id="i-shield" viewBox="0 0 16 16"><path d="M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z"/></symbol>
    <symbol id="i-sun" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></symbol>
    <symbol id="i-moon" viewBox="0 0 16 16"><path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z"/></symbol>
    <symbol id="i-logo" viewBox="0 0 18 18"><circle cx="3.5" cy="9" r="2"/><circle cx="9" cy="9" r="2"/><circle cx="14.5" cy="9" r="2"/><path d="M5.5 9h1.5M11 9h1.5"/></symbol>
  </defs>
</svg>

`;

const escape = (value: string | number) => String(value).replace(/[&<>"']/g,
  character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]!);
const icon = (name: string) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const tip = (text: string, focus = true) => `data-tip="${escape(text)}" aria-label="${escape(text)}"${focus ? ' tabindex="0" role="img"' : ''}`;
const bytes = (n: number) => n < 1e6 ? `${Math.round(n/1e3)} KB` : n < 1e9 ? `${(n/1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n/1e9).toFixed(2)} GB`;
const duration = (ms: number) => {
  const m = Math.round(Math.max(0,ms)/60000);
  return m < 1 ? `${Math.round(Math.max(0,ms)/1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m/60)}h${m%60 ? ` ${m%60}m` : ''}`;
};
const tokens = (value: number) => new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value).replace('K','k');
const inputTokens = (value: number) => `${(value/1e6).toFixed(1)}M`;
const runStates = new Map<string,[string,string]>([
  ['pending',['idle','Pending']],['running',['run','Running']],['parked',['wait','Paused']],
  ['complete',['ok','Complete']],['accepted_blocked',['dlv','Accepted blocked']],['incomplete',['wait','Incomplete']],
  ['failed',['bad','Failed']],['escalated',['wait','Needs you']],['cancelled',['off','Cancelled']],
  ['interrupted',['wait','Interrupted']],['unknown',['wait','Unknown']],
]);
export const needsYou = (s: RunStatusFile) => ['parked','escalated','interrupted','unknown'].includes(s.status) || activityNotices(s).length > 0 || commandLimit(s) !== null;
export const ended = (s: RunStatusFile) => ['complete','accepted_blocked','incomplete','failed','cancelled'].includes(s.status);
const reasons = new Map(Object.entries({
  completed:'The run completed.',accepted_blocked:'The reviewer accepted the declared blockers.',
  gate_irreparable:'The review found work that cannot be repaired.',command_missing:'A required command has no recorded result.',
  command_nonzero:'A required command exited unsuccessfully.',command_unfinished:'A required command did not finish.',
  outputs_unpreserved:'The outputs have not been preserved.',backstop:'The automatic pause threshold was reached.',
  attempt_failed:'An attempt failed.',contract_refused:'The engine refused the declared contract.',
  isolation_refused:'The execution boundary was refused.',cancelled:'The run was cancelled.',
  recovery_unknown:'Controller recovery needs a decision.',closure_unconfirmed:'Process closure is unconfirmed.',
  accounting_unsettled:'Execution accounting remains unsettled.',claim_unreleased:'A resource claim remains held.',
}));
const stageName = (st: RunStageStatus) => st.purpose === 'plan' ? 'Plan' : st.id.charAt(0).toUpperCase()+st.id.slice(1).replaceAll('_',' ');
const hm = (at: string) => `<time data-clock datetime="${escape(at)}">${escape(at)}</time>`;
const purpose = new Map([['plan','Planner'],['work','Work'],['gate','Review']]);
const ownerKinds = new Map([['claude','Claude Code'],['codex','Codex']]);
function owner(s: RunStatusFile) {
  if (s.notification.session !== 'bound') return {label:'No session',icon:'belloff',
    tip:'No session is bound, so none was woken. Ask any Claude Code or Codex session; it finds the run with flowcrew status.'};
  const requester = s.requester ?? '', separator = requester.indexOf(':');
  const prefix = separator < 0 ? requester : requester.slice(0,separator), session = separator < 0 ? '' : requester.slice(separator+1);
  const kind = ownerKinds.get(prefix) ?? prefix;
  return {label:`${kind} · ${session.slice(0,4)}…`,icon:'bell',
    tip:`${kind} session ${session} launched this run and is woken on every state change`};
}
const endingTone = (ending: StageSegment['ending'] | null, purpose: RunStageStatus['purpose']) => !ending ? 'idle'
  : ending === 'delivered' ? purpose === 'plan' ? 'ok' : 'dlv' : ending === 'cancelled' ? 'off' : ['invalid_answer','invalid_plan'].includes(ending) ? 'wait' : 'bad';
function stageTone(st: RunStageStatus): string {
  if (st.state === 'running') return 'run';
  if (['parked','needs-correction','interrupted','unknown'].includes(st.state)) return 'wait';
  if (st.verdict) return ({accepted:'ok',accepted_blocked:'dlv',rejected_repairable:'bad',rejected_irreparable:'bad'} as Record<string,string>)[st.verdict] ?? 'idle';
  if (st.lastEnding) return endingTone(st.lastEnding,st.purpose);
  return st.state === 'skipped' ? 'off' : 'idle';
}
const spanMs = (part: StageSegment, s: RunStatusFile, now: number): number | null => part.elapsedMs ?? (part.startedAt === null ? null : Math.max(0,
  Date.parse(part.endedAt ?? (part.kind === 'pause' || s.status === 'running' ? new Date(now).toISOString() : s.lastActivityAt ?? part.startedAt)) - Date.parse(part.startedAt)));
const trackStages = (s: RunStatusFile) => s.stages?.filter(st => !st.replacedBy || st.purpose === 'plan') ?? [];
function recordedTime(parts: readonly StageSegment[], s: RunStatusFile, now: number): string {
  const times = parts.map(part => spanMs(part,s,now)), known = times.filter((time): time is number => time !== null);
  return known.length ? duration(known.reduce((sum,time)=>sum+time,0)) : '—';
}
const segmentLabel = (part: StageSegment) => part.kind === 'pause' ? 'Paused' : part.attempt === undefined ? 'Recorded stage interval' : `Attempt ${part.attempt} · invocation ${part.invocation}${part.ending ? ` · ${part.ending}` : ''}`;
function segment(part: StageSegment, st: RunStageStatus, s: RunStatusFile, now: number): string {
  const disposition = endingTone(part.ending,st.purpose), failed = part.ending !== undefined && !['delivered','cancelled'].includes(part.ending);
  const live = part.kind === 'attempt' && part.startedAt !== null && part.endedAt === null && !part.ending && s.status === 'running';
  const tone = part.kind === 'pause' ? 'gap' : live ? 's-run' : `s-${disposition}`;
  const text = segmentLabel(part);
  const time = spanMs(part,s,now);
  return `<span class="p ${tone}${live ? ' live' : ''}${failed ? ' x' : ''}" style="flex:${time ?? 0} 1 0" ${tip(`${text} · ${time === null ? 'time unavailable' : `${duration(time)} · ${part.startedAt}–${part.endedAt ?? 'open'}`}`)}>${failed ? icon('bad') : ''}</span>`;
}
const futureStage = (st: RunStageStatus) => !st.attempts && !st.segments?.length && st.state === 'pending';
const current = (s: RunStatusFile) => s.stages?.find(st => !st.replacedBy && st.id === s.focus);
function track(s: RunStatusFile, now: number, mini = false): string {
  const stages = trackStages(s);
  if (!stages.length) return '';
  const cur = current(s);
  return `<div class="bar${mini ? ' mini' : ''}" aria-label="Stage track">${stages.map(st => {
    const tone = stageTone(st), parts = st.segments ?? [], future = futureStage(st);
    if (mini && future) return '';
    const shape = st.purpose === 'gate' ? ' sq' : '';
    const text = `${stageName(st)} · ${purpose.get(st.purpose) ?? st.purpose} · ${st.role} · ${st.verdict ?? st.lastEnding ?? st.state}`;
    const elapsed = parts.reduce((sum,part)=>sum+(spanMs(part,s,now) ?? 0),0);
    return `<div class="stg s-${tone}${future ? ' fut' : ''}${cur === st ? ' cur' : ''}${st.purpose === 'plan' ? ' planner' : ''}" data-stage="${escape(st.id)}"${cur === st ? ' aria-current="step"' : ''}${future ? '' : ` style="flex:${elapsed/60000} 1 ${mini ? 6 : 26}px"`}>
      ${mini ? '' : `<span class="node${shape}" ${tip(text)}>${future ? '' : icon(tone)}</span>`}${future ? '<span class="stub"></span>' : `<span class="parts">${parts.map(part => segment(part,st,s,now)).join('')}</span>`}</div>`;
  }).join('')}</div>`;
}
function under(s: RunStatusFile, now: number): string {
  const st = current(s);
  if (!st) return '';
  const planned = s.stages?.filter(row => !row.replacedBy && row.purpose !== 'plan') ?? [];
  const position = planned.indexOf(st), checks = st.state === 'running' && st.purpose === 'gate' ? st.commandProgress : undefined;
  const progress=activityWords(s,st.id,now);
  return `<div class="under" data-key="under"><span class="ul"><span class="curlab s-${stageTone(st)}" ${tip(`${stageName(st)} · ${purpose.get(st.purpose) ?? st.purpose} · ${st.role}`,false)}>${escape(stageName(st))}${position < 0 ? '' : `<b>${position+1}/${planned.length}</b>`}</span>${checks?.length ? `<span class="ckg"><span class="checks">${checks.map(check => `<i class="ck s-${({passed:'ok',running:'run',not_started:'idle',failed:'bad',unfinished:'wait'})[check.state]}" ${tip(`${check.command} · ${check.state}`)}></i>`).join('')}</span><span class="ckn">${checks.filter(check=>['passed','running'].includes(check.state)).length}/${checks.length}</span></span>` : ''}</span>${progress ? `<div>${escape(progress)}</div>` : ''}</div>`;
}
function activityWords(s: RunStatusFile, stage: string, now: number): string {
  const item=s.status === 'running' ? s.activity?.find(item=>item.stage === stage && item.state === 'current') : undefined;
  if (!item) return '';
  return `running ${item.toolRunning ? item.lastTool ?? item.source : item.source}${item.summary ? `: ${item.summary}` : ''} · last progress ${item.lastEventAt
    ? `${duration(Math.max(0,now-Date.parse(item.lastEventAt)))} ago` : 'unknown'}${item.notice ? ` · ${item.notice.message}` : ''}`;
}
function details(s: RunStatusFile, now: number): string {
  const o = owner(s);
  const rows = (s.stages ?? []).map(st => {
    const parts = st.segments?.filter(part=>part.kind === 'attempt'), pauses = st.segments?.filter(part=>part.kind === 'pause');
    const time = st.segments?.length ? recordedTime(parts ?? [],s,now) + (st.state === 'running' ? ' so far' : '')
      + (pauses?.length ? ` + ${recordedTime(pauses,s,now)} paused` : '') : '—';
    const tries = futureStage(st) ? '—' : parts ? parts.map(part=>`<span ${tip(segmentLabel(part))}>${icon(part.ending ? endingTone(part.ending,st.purpose) : s.status === 'running' ? 'run' : 'wait')}</span>`).join('') : escape(st.attempts);
    return `<tr class="s-${stageTone(st)}" ${tip(`${st.id} · ${st.role}${st.replacedBy ? ` · replaced by ${st.replacedBy}` : ''}`,false)}><td class="nm"><span class="in"><span class="node${st.purpose === 'gate' ? ' sq' : ''}">${icon(stageTone(st))}</span><span><b>${escape(stageName(st))}</b><small>${escape(purpose.get(st.purpose) ?? st.purpose)}</small></span></span></td><td><span class="tally" aria-label="${st.attempts} ${st.attempts === 1 ? 'attempt' : 'attempts'}">${tries}</span></td><td>${time}</td><td class="res">${escape(activityWords(s,st.id,now) || st.summary || (st.state === 'pending' ? 'Not started.' : ''))}</td></tr>`;
  }).join('');
  const why = s.stopReason ? `<li>${icon('hand')}<span>${escape(reasons.get(s.stopReason) ?? s.stopReason)}</span></li>` : '';
  const message = s.attention?.detail ? `<li>${icon('hand')}<span>${escape(s.attention.detail)}</span></li>` : '';
  const checkpoints = s.checkpoints ? `<li>${icon('shield')}<span>${s.checkpoints.count ? `Work is safe: ${s.checkpoints.count} checkpoint${s.checkpoints.count === 1 ? '' : 's'} saved${s.checkpoints.latestAt ? `, the latest at ${hm(s.checkpoints.latestAt)}` : ''}` : 'No checkpoint saved yet'}.</span></li>` : '';
  const u = s.usage;
  const tokenParts = u.input !== undefined && u.cached !== undefined ? `<div class="ubar" role="img" aria-label="Input tokens"><i class="c" style="width:${u.input ? u.cached/u.input*100 : 0}%" ${tip(`Cached input · ${inputTokens(u.cached)}`)}></i><i class="f" style="width:${u.input ? (u.input-u.cached)/u.input*100 : 0}%" ${tip(`New input · ${inputTokens(u.input-u.cached)}`)}></i></div>` : '';
  const usage = [u.input,u.output,u.cached].some(value=>value !== undefined) ? `<div><p class="h3">Tokens</p>${tokenParts}<div class="ukey">${u.input !== undefined && u.cached === undefined ? `<span>input <b>${inputTokens(u.input)}</b></span>` : ''}${u.cached === undefined ? '' : `<span><i class="c"></i>cached <b>${inputTokens(u.cached)}</b></span>`}${u.input === undefined || u.cached === undefined ? '' : `<span><i class="f"></i>new <b>${inputTokens(u.input-u.cached)}</b></span>`}${u.output === undefined ? '' : `<span>output <b>${tokens(u.output)}</b></span>`}</div></div>` : '';
  const meters = [['Non-passing reviews in a row',s.backstop.gateSuffix,s.backstop.gateThreshold],['Refused or failed tries in a row',s.backstop.failureSuffix,s.backstop.failureThreshold]] as const;
  const safety = `<div><p class="h3">Automatic pause</p>${meters.map(([label,value,max])=>`<div class="meter ${value >= max ? 's-wait' : 's-ok'}"><div class="rw"><span>${label}</span><b>${value} / ${max}</b></div><div class="pips" role="img" aria-label="${label}: ${value}/${max}">${Array.from({length:max},(_,i)=>`<i${i < value ? ' class="on"' : ''}></i>`).join('')}</div>${value >= max && s.backstop.pausedAt ? `<span class="note" style="margin:0">Limit reached: paused at ${hm(s.backstop.pausedAt)}</span>` : ''}</div>`).join('')}</div>`;
  return `<div class="tbl"><table><thead><tr><th>Stage</th><th>Tries</th><th>Time</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="why">${why}${message}<li>${icon(o.icon)}<span>${escape(o.tip)}</span></li>${checkpoints}</ul><div class="cols">${usage}${safety}</div>`;
}
const more = (key: string) => `<button type="button" class="iconbtn more-btn" data-key="more" aria-expanded="false" aria-controls="m-${escape(key)}" aria-label="Details" data-tip="Details">${icon('chev')}</button>`;
export function runCard(run: string, s: RunStatusFile | null, now: number, key: string): string {
  const shortId = run.slice(0,16);
  if (!s) return `<article class="glass row unavailable s-idle" data-key="${escape(key)}" data-status="unavailable"><div class="r1"><span class="badge" ${tip('Snapshot missing, unreadable or unsupported.')}>${icon('idle')}</span><h3 ${tip(run,false)}>${escape(shortId)}</h3><span class="unknown-state">No status</span></div></article>`;
  const [tone,label] = runStates.get(s.status) ?? ['idle',s.status], o = owner(s), isEnded = ended(s);
  const stateLabel = s.interruption?.detail ?? label;
  const fresh = s.lastActivityAt ? `<span class="fresh" ${tip(`Last activity ${s.lastActivityAt}`)}>${icon('pulse')}<time datetime="${s.lastActivityAt}" data-age>${duration(now-Date.parse(s.lastActivityAt))}</time></span>` : '';
  const parts = trackStages(s).flatMap(st=>st.segments ?? []), partial = parts.some(part=>spanMs(part,s,now) === null);
  const elapsed = parts.length ? `<span class="total" ${tip(`Recorded track time${partial ? '; some try times unavailable' : ''}`)}>${recordedTime(parts,s,now)}</span>` : '';
  /* status decides who holds bytes: it publishes heldBytes only for an unlanded final run */
  const held = s.heldBytes !== undefined ? `<span class="fresh" ${tip(`Space this ended run still holds; flowcrew land ${run} keeps the deliveries and frees it`)}>${bytes(s.heldBytes)} held</span>` : '';
  const endedAge = s.endedAt ? `<span class="fresh" ${tip(`Ended ${s.endedAt}`)}>ended <time datetime="${s.endedAt}" data-age>${duration(now-Date.parse(s.endedAt))}</time> ago</span>` : '';
  const runLabel = s.title ?? shortId;
  const title = `<span class="badge" ${tip(stateLabel)}>${icon(tone)}</span><${isEnded ? 'h3' : 'h2'} ${tip(run,false)}>${escape(runLabel)}</${isEnded ? 'h3' : 'h2'}>`;
  const notices=activityNotices(s);
  const attentionLabel = commandLimit(s) ? 'Past its time limit' : notices.length ? 'No observed progress' : s.status === 'parked' && s.attention?.cause === 'resume_refused' ? 'Resume refused'
    : s.status === 'parked' && s.attention?.reason === 'backstop' ? 'Paused at run limit' : stateLabel;
  const attention = needsYou(s) && !isEnded ? `<div class="r3" data-key="attention"><span class="status s-${tone}" ${tip(notices.map(item=>item.notice?.message).join('; ') || s.attention?.detail || stateLabel,false)}>${icon('hand')}${escape(attentionLabel)}</span><span class="goto" ${tip(o.tip)}>${icon('arrow')}${icon(o.icon)}${escape(o.label)}</span></div>` : '';
  return `<article class="glass ${isEnded ? 'row' : 'run'} s-${tone}" data-key="${escape(key)}" data-status="${escape(s.status)}"><div class="r1" data-key="heading">${title}${isEnded ? track(s,now,true)+held+endedAge : fresh+held}${!needsYou(s) && !isEnded ? `<span class="own" ${tip(o.tip)}>${icon(o.icon)}</span>` : ''}${more(key)}</div>${isEnded ? '' : `<div class="trackrow" data-key="track">${track(s,now)}${elapsed}</div>${under(s,now)}${attention}`}<div class="more-body" data-key="details" id="m-${escape(key)}" hidden>${details(s,now)}</div></article>`;
}
export function summary(statuses: readonly RunStatusFile[], now: number, unavailable = false): string {
  const groups = [['wait','Needs you',statuses.filter(needsYou).length],['run','Running',statuses.filter(s=>s.status === 'running').length],['off','Ended · 24h',statuses.filter(s=>ended(s) && s.endedAt && now-Date.parse(s.endedAt) <= 86400000 && now >= Date.parse(s.endedAt)).length]] as const;
  const chips = groups.map(([tone,label,count])=>`<a class="s-${tone}" href="#runs" aria-label="${count} ${label}"><span class="ic">${icon(tone)}</span><b>${count}</b><span class="lb">${label}</span></a>`).join('');
  const measured = statuses.filter(s=>s.heldBytes !== undefined);
  const total = measured.reduce((sum,s)=>sum+s.heldBytes!,0);
  const incomplete = unavailable || statuses.some(s=>s.heldSpacePending);
  const text = `Space held by ${measured.length} ended run${measured.length === 1 ? '' : 's'} not yet landed: ${bytes(total)}${incomplete ? '; incomplete: some runs are unavailable or unmeasured' : ''}`;
  return chips + (measured.length || incomplete ? `<a class="s-idle" href="#runs" ${tip(text,false)} data-held="${total}"><span class="ic">${icon('idle')}</span><b>${bytes(total)}</b><span class="lb">${incomplete ? 'held · incomplete' : 'held, not landed'}</span></a>` : '');
}
export const legend = `<h3>Legend</h3><div class="lg">${[['ok','Passed (plan accepted or review passed)'],['dlv','Delivered by the author, not reviewed yet'],['run','Running'],['wait','Needs you'],['bad','Refused or failed'],['off','Cancelled'],['idle','Not started']].map(([tone,text])=>`<span class="sw s-${tone}"><span class="node">${icon(tone)}</span></span><span>${text}</span>`).join('')}<span class="sw"><span class="node sq"></span></span><span>Square node: a review stage</span><span class="sw">${icon('bell')}</span><span>A session owns this run and is woken on changes</span><span class="sw">${icon('belloff')}</span><span>No session owns this run</span><span class="sw"><span class="p gap" style="width:24px;height:10px"></span></span><span>Paused or parked</span><span class="sw"><span class="stub"></span></span><span>Stage not started (fixed length)</span></div><p>Timed segments show recorded time; untimed tries show outcomes only. Hover or tap anything for details. Read-only: act in your Claude Code or Codex session.</p>`;

export const script = `
const icon = name => '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
function placeLabels() {
  for (const u of document.querySelectorAll('.under')) {
    const cur = u.closest('article').querySelector('.bar .stg.cur'), ul = u.firstElementChild;
    if (!cur) continue;
    u.style.paddingLeft = '0';
    const x = cur.getBoundingClientRect().left - u.getBoundingClientRect().left;
    u.style.paddingLeft = Math.max(0, Math.min(x, u.clientWidth - ul.offsetWidth)) + 'px';
  }
}
placeLabels(); addEventListener('resize',placeLabels);
const tipEl = document.getElementById('tip');
let lastPointer = 'mouse', tipTimer;
const showTip = el => {
  tipEl.textContent = el.dataset.tip; tipEl.hidden = false;
  const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
  tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'; tipEl.style.top = y + 'px';
};
document.addEventListener('pointerdown', e => { lastPointer = e.pointerType; });
document.addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (el && e.pointerType === 'mouse') showTip(el); });
document.addEventListener('pointerout', e => { if (e.pointerType === 'mouse' && e.target.closest('[data-tip]')) tipEl.hidden = true; });
document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el && lastPointer !== 'touch') showTip(el); });
document.addEventListener('focusout', () => { tipEl.hidden = true; });
addEventListener('scroll', () => { tipEl.hidden = true; }, { passive: true });

document.addEventListener('click', e => {
  const m = e.target.closest('.more-btn');
  if (m) { const open = m.getAttribute('aria-expanded') !== 'true'; m.setAttribute('aria-expanded', open); document.getElementById(m.getAttribute('aria-controls')).hidden = !open; placeLabels(); return; }
  const h = e.target.closest('#help'), lg = document.getElementById('legend');
  if (h) { lg.hidden = !lg.hidden; h.setAttribute('aria-expanded', !lg.hidden); return; }
  if (!e.target.closest('#legend')) { lg.hidden = true; document.getElementById('help').setAttribute('aria-expanded', 'false'); }
  const t = e.target.closest('[data-tip]');
  if (t && lastPointer === 'touch') { showTip(t); clearTimeout(tipTimer); tipTimer = setTimeout(() => { tipEl.hidden = true; }, 2600); }
});

const root = document.documentElement, themeBtn = document.getElementById('theme');
const paintTheme = () => { const dark = root.dataset.theme !== 'light'; themeBtn.innerHTML = icon(dark ? 'sun' : 'moon'); themeBtn.setAttribute('aria-label', dark ? 'Light theme' : 'Dark theme'); themeBtn.dataset.tip = dark ? 'Light theme' : 'Dark theme'; };
themeBtn.onclick = () => { root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light'; paintTheme(); };
paintTheme();
function reconcile(current, next) {
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.data !== next.data) current.data = next.data;
    return;
  }
  if (current.nodeType !== Node.ELEMENT_NODE) return;
  const local = name => current.classList.contains('more-btn') && name === 'aria-expanded'
    || current.classList.contains('more-body') && name === 'hidden';
  for (const attribute of [...current.attributes]) {
    if (!local(attribute.name) && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (!local(attribute.name) && current.getAttribute(attribute.name) !== attribute.value)
      current.setAttribute(attribute.name, attribute.value);
  }
  if (current.tagName === 'TIME') return;
  const keyed = new Map([...current.children].filter(node => node.hasAttribute('data-key'))
    .map(node => [node.getAttribute('data-key'), node]));
  const nextKeys = new Set([...next.children].map(node => node.getAttribute('data-key')));
  for (const [key, node] of keyed) if (!nextKeys.has(key)) node.remove();
  let cursor = current.firstChild;
  for (const incoming of [...next.childNodes]) {
    const key = incoming.nodeType === Node.ELEMENT_NODE ? incoming.getAttribute('data-key') : null;
    let node = key === null ? cursor : keyed.get(key);
    if (!node || node.nodeType !== incoming.nodeType || node.nodeName !== incoming.nodeName
      || key === null && node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-key')) {
      node = incoming.cloneNode(true);
      current.insertBefore(node, cursor);
    } else {
      if (node !== cursor) current.insertBefore(node, cursor);
      reconcile(node, incoming);
    }
    cursor = node.nextSibling;
  }
  while (cursor) { const removed = cursor; cursor = cursor.nextSibling; removed.remove(); }
}

const clock = new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function updateAges() {
  for (const time of document.querySelectorAll('time[data-clock]')) {
    const value = clock.format(new Date(time.dateTime));
    if (time.textContent !== value) time.textContent = value;
  }
  for (const time of document.querySelectorAll('time[data-age]')) {
    const ms = Math.max(0,Date.now()-Date.parse(time.dateTime)), m = ms/60000;
    const value = m < 1 ? Math.round(ms/1000)+'s' : m < 60 ? Math.round(m)+'m' : Math.round(m/60)+'h';
    if (time.textContent !== value) time.textContent = value;
    const fresh = time.closest('.run .fresh'), opacity = String(m < 1 ? 1 : m < 10 ? .9 : m < 60 ? .78 : .62);
    if (fresh && fresh.style.opacity !== opacity) fresh.style.opacity = opacity;
  }
}
async function poll() {
  const dot = document.getElementById('poll-health');
  try {
    const response = await fetch('/',{method:'GET',cache:'no-store'});
    if (!response.ok) throw new Error('Refresh unavailable');
    const next = new DOMParser().parseFromString(await response.text(),'text/html');
    const focused = document.activeElement;
    reconcile(document.getElementById('runs'),next.getElementById('runs'));
    reconcile(document.getElementById('sum'),next.getElementById('sum'));
    if (focused.isConnected && document.activeElement !== focused) focused.focus({preventScroll:true});
    dot.classList.remove('poll-down');
    dot.dataset.tip = 'Live · refreshes every 5 s';
    document.title = next.title;
    updateAges(); placeLabels();
  } catch {
    dot.classList.add('poll-down');
    dot.dataset.tip = 'Refresh unavailable · showing previous snapshot';
  } finally { setTimeout(poll,5000); }
}
updateAges(); setInterval(updateAges,1000); setTimeout(poll,5000);

`;
