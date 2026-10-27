// Direction visuelle : surfaces blanches, encre #09090b, note #71717a, bordure #e4e4e7, accent #2563eb pour le focus et les états.
export const PANEL_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font: 14px/20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #09090b; background: #fff; -webkit-font-smoothing: antialiased; }
svg { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.socrate-panel { display: flex; flex-direction: column; height: 100%; }
.socrate-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #e4e4e7; }
.socrate-header h1 { font-size: 14px; line-height: 20px; font-weight: 600; margin: 0; }
.socrate-body { flex: 1; overflow: auto; padding: 16px; }
.socrate-section { margin-bottom: 20px; }
.socrate-section h2 { font-size: 12px; font-weight: 500; color: #71717a; margin: 0 0 8px; }
.socrate-section p { margin: 0 0 6px; }
.socrate-zone, .socrate-thread { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.socrate-zone h3 { margin: 0 0 4px; font-size: 14px; }
.socrate-zone ul { margin: 6px 0 0; padding-left: 18px; }
.socrate-thread[data-state="resolved"] { background: #fafafa; }
.socrate-thread-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.socrate-badge { font-size: 12px; line-height: 16px; font-weight: 500; padding: 2px 8px; border-radius: 999px; background: #eff6ff; color: #1d4ed8; }
.socrate-thread[data-state="resolved"] .socrate-badge { background: #f0fdf4; color: #15803d; }
.socrate-message { padding: 6px 0; }
.socrate-meta { font-size: 12px; line-height: 16px; color: #71717a; }
.socrate-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.socrate-status { padding: 8px 10px; border: 1px solid #e4e4e7; border-radius: 8px; margin-bottom: 8px; font-size: 13px; line-height: 18px; background: #fafafa; color: #3f3f46; }
.socrate-status[data-kind="error"] { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.socrate-status[data-kind="success"] { background: #f0fdf4; border-color: #bbf7d0; color: #15803d; }
.socrate-shot { margin: 0 0 8px; }
.socrate-shot img, .socrate-target img, .socrate-details img { max-width: 100%; border: 1px solid #e4e4e7; border-radius: 6px; }
.socrate-target dl, .socrate-details dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 4px 0; }
.socrate-target dd, .socrate-details dd { margin: 0; overflow-wrap: anywhere; }
pre.socrate-html { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; background: #f4f4f5; padding: 6px; border-radius: 6px; max-height: 120px; overflow: auto; }
.socrate-details { border-top: 1px solid #e4e4e7; margin: 8px 0; padding-top: 8px; }
.socrate-confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.socrate-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
button { font: inherit; color: inherit; }
button.socrate-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 12px; border: 1px solid #18181b; border-radius: 8px; background: #18181b; color: #fff; font-size: 13px; font-weight: 500; cursor: pointer; }
button.socrate-button:hover:not(:disabled) { background: #27272a; }
button.socrate-button.secondary { background: #fff; color: #09090b; border-color: #e4e4e7; box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
button.socrate-button.secondary:hover:not(:disabled) { background: #f4f4f5; }
button.socrate-button.link { display: inline; min-height: 0; padding: 0; border: none; background: none; color: #2563eb; font-size: inherit; text-decoration: underline; text-underline-offset: 2px; }
button.socrate-button.link:hover:not(:disabled) { background: none; color: #1d4ed8; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
textarea.socrate-textarea { width: 100%; min-height: 72px; font: inherit; padding: 8px 10px; border: 1px solid #e4e4e7; border-radius: 10px; resize: vertical; }
.socrate-avatar { flex: none; display: inline-grid; place-items: center; border-radius: 50%; color: #fff; font-size: 10px; font-weight: 600; letter-spacing: -.02em; }
.socrate-avatar[data-size="28"] { font-size: 11px; }
button.socrate-icon { flex: none; display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: 6px; background: none; color: #71717a; cursor: pointer; }
button.socrate-icon:hover:not(:disabled) { background: #f4f4f5; color: #09090b; }
.socrate-composer { display: flex; gap: 8px; align-items: flex-start; }
.socrate-composer > .socrate-avatar { margin-top: 6px; }
.socrate-field { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid #e4e4e7; border-radius: 10px; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
.socrate-field:focus-within { border-color: #2563eb; box-shadow: 0 0 0 3px rgb(37 99 235 / .16); }
.socrate-field textarea { min-height: 36px; max-height: 160px; field-sizing: content; resize: none; border: none; outline: none; padding: 8px 10px 4px; font: inherit; color: inherit; background: none; }
.socrate-field textarea::placeholder { color: #71717a; }
.socrate-field textarea[readonly] { color: #71717a; }
.socrate-field-foot { display: flex; align-items: center; gap: 2px; padding: 0 4px 4px; min-height: 32px; }
button.socrate-send { flex: none; margin-left: auto; width: 28px; height: 28px; border: none; border-radius: 50%; padding: 0; display: grid; place-items: center; background: #18181b; color: #fff; cursor: pointer; }
button.socrate-send:hover:not(:disabled) { background: #3f3f46; }
button.socrate-send:disabled { background: #f4f4f5; color: #a1a1aa; opacity: 1; }
.socrate-drop { position: absolute; inset: -1px; z-index: 1; display: grid; place-items: center; padding: 8px; border: 1.5px dashed #2563eb; border-radius: 10px; background: #eff6ff; color: #1d4ed8; font-size: 13px; font-weight: 500; text-align: center; pointer-events: none; }
.socrate-hint { margin: 6px 0 0 32px; }
.socrate-bubble { padding: 12px; }
.socrate-bubble-head { display: flex; align-items: center; gap: 2px; margin: -4px -4px 8px 0; min-height: 28px; }
.socrate-bubble-head > :first-child { flex: 1; font-size: 13px; font-weight: 600; }
.socrate-msg { display: flex; gap: 8px; padding: 6px 0; }
.socrate-msg > div { min-width: 0; flex: 1; }
.socrate-msg p { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.socrate-msg strong, .socrate-row strong { font-size: 13px; font-weight: 600; margin-right: 6px; }
.socrate-msg time, .socrate-row time { font-size: 12px; color: #71717a; }
.socrate-messages { max-height: 300px; overflow: auto; margin-bottom: 8px; }
.socrate-quote { margin: 0 0 8px; padding: 6px 10px; border-left: 2px solid #d4d4d8; background: #fafafa; border-radius: 0 8px 8px 0; }
.socrate-quote p { margin: 0; }
.socrate-list-head { padding: 12px 8px 10px 16px; border-bottom: 1px solid #e4e4e7; }
.socrate-list-title { display: flex; align-items: center; gap: 2px; }
.socrate-list-title h1 { flex: 1; font-size: 14px; line-height: 20px; font-weight: 600; margin: 0; }
h1[tabindex="-1"]:focus { outline: none; }
.socrate-list-head > .socrate-meta { margin: 2px 8px 0 0; }
.socrate-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.socrate-filter { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: #f4f4f5; }
.socrate-filter button { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border: none; border-radius: 6px; background: none; color: #52525b; font-size: 12px; font-weight: 500; cursor: pointer; }
.socrate-filter button:hover { color: #09090b; }
.socrate-filter button[aria-pressed="true"] { background: #fff; color: #09090b; box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 0 0 1px rgb(0 0 0 / .03); }
.socrate-count { font-variant-numeric: tabular-nums; color: #71717a; }
.socrate-empty { margin: 32px 16px; display: grid; gap: 8px; justify-items: center; text-align: center; color: #71717a; font-size: 13px; line-height: 18px; }
.socrate-empty > svg { width: 40px; height: 40px; padding: 10px; border-radius: 50%; background: #f4f4f5; color: #71717a; }
.socrate-empty p { margin: 0; }
.socrate-empty > p:first-of-type { color: #09090b; font-weight: 500; }
.socrate-rows { list-style: none; margin: 0; padding: 6px 8px; }
.socrate-row-line { display: flex; align-items: flex-start; gap: 2px; }
.socrate-row-line > button.socrate-icon { margin-top: 6px; }
.socrate-goto { margin: -4px 0 6px 40px; font-size: 12px !important; }
.socrate-row { display: flex; gap: 8px; flex: 1; min-width: 0; text-align: left; background: none; border: none; border-radius: 8px; padding: 8px; cursor: pointer; }
.socrate-row:hover, .socrate-row[aria-expanded="true"] { background: #f4f4f5; }
.socrate-row > span:last-child { min-width: 0; flex: 1; }
.socrate-row-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 2px 0; font-size: 13px; line-height: 18px; color: #3f3f46; overflow-wrap: anywhere; }
.socrate-row-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; line-height: 16px; color: #71717a; }
.socrate-row-foot > span { display: inline-flex; align-items: center; gap: 4px; }
.socrate-row-foot svg { width: 12px; height: 12px; }
.socrate-tag { padding: 0 6px; border: 1px solid #e4e4e7; border-radius: 999px; }
li[data-state="resolved"] .socrate-row { opacity: .65; }
.socrate-inline { margin: 0 0 8px 20px; padding: 0 4px 8px 12px; border-left: 1px solid #e4e4e7; }
.socrate-general { flex: none; padding: 12px; border-top: 1px solid #e4e4e7; background: #fff; }
.socrate-general .socrate-field textarea { min-height: 60px; max-height: 200px; }
.socrate-general .socrate-hint { margin-left: 32px; }
.socrate-general .socrate-field { max-height: max(25vh, 100px); overflow: auto; }
.socrate-general .socrate-field-foot { position: sticky; bottom: 0; background: #fff; }
@media (max-height: 520px) { .socrate-general .socrate-hint { display: none; } }
.socrate-state { display: inline-flex; align-items: center; gap: 6px; }
.socrate-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #2563eb; }
.socrate-state[data-state="resolved"]::before { background: #16a34a; }
.socrate-menu { position: fixed; z-index: 2; display: grid; min-width: 200px; padding: 4px; border-radius: 10px; background: #fff; border: 1px solid #e4e4e7; box-shadow: 0 10px 24px -6px rgb(0 0 0 / .16), 0 2px 4px rgb(0 0 0 / .04); }
.socrate-menu button { text-align: left; border: none; background: none; border-radius: 6px; padding: 7px 8px; font-size: 13px; line-height: 18px; cursor: pointer; }
.socrate-menu button:hover, .socrate-menu button:focus-visible { background: #f4f4f5; outline: none; }
[data-socrate="tip"] { position: fixed; z-index: 3; max-width: 240px; padding: 4px 8px; border-radius: 6px; background: #18181b; color: #fafafa; font-size: 12px; line-height: 16px; pointer-events: auto; }
@media (prefers-reduced-motion: no-preference) { .socrate-bubble { animation: socrate-in 120ms ease-out; transform-origin: top left; } @keyframes socrate-in { from { opacity: 0; transform: scale(.98); } } }
.socrate-tray { padding: 2px 6px 4px; }
.socrate-tray ul, .socrate-media { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.socrate-tray > p { margin: 6px 4px 0; }
.socrate-chip { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 4px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
.socrate-chip-preview { width: 32px; height: 32px; flex-shrink: 0; display: grid; place-items: center; overflow: hidden; border-radius: 6px; background: #f4f4f5; color: #71717a; }
.socrate-chip-preview img, .socrate-chip-preview video { width: 100%; height: 100%; object-fit: cover; }
.socrate-chip-text { min-width: 0; flex: 1; display: grid; }
.socrate-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; font-weight: 500; }
.socrate-media { margin-top: 8px; }
.socrate-media-item { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.socrate-media-item img, .socrate-media-item video { display: block; width: 100%; max-height: 220px; object-fit: contain; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
.socrate-media-load { display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 40px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fff; font-size: 13px; cursor: pointer; }
.socrate-media-load:hover { background: #f4f4f5; }
`;

/** Éléments posés dans le document de l'hôte : uniquement sous `[data-socrate]`, aucun style de l'hôte n'est modifié. */
export const HOST_CSS = `
[data-socrate="toolbar"]{all:initial;position:fixed;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483001;box-sizing:border-box;display:flex;align-items:center;gap:2px;height:48px;padding:4px;border-radius:999px;background:#fff;color:#3f3f46;border:1px solid #e4e4e7;box-shadow:0 1px 2px rgb(0 0 0/.06),0 8px 24px -8px rgb(0 0 0/.18);font:500 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap}
[data-socrate="toolbar"] button,[data-socrate="menu"] button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;min-width:38px;padding:0;border-radius:999px;cursor:pointer;font:inherit}
[data-socrate="toolbar"] button:has([data-label]),[data-socrate="toolbar"] [data-socrate-action="draft"]{padding:0 12px 0 10px}
[data-socrate="toolbar"] button:hover,[data-socrate="toolbar"] button[aria-expanded="true"]{background:#f4f4f5;color:#09090b}
[data-socrate="toolbar"] [data-socrate-action="target"]{background:#2563eb;color:#fff}
[data-socrate="toolbar"] [data-socrate-action="target"]:hover,[data-socrate="toolbar"] button[aria-pressed="true"]{background:#1d4ed8;color:#fff}
[data-socrate="toolbar"] button[aria-pressed="true"]{padding:0;box-shadow:inset 0 0 0 2px rgb(255 255 255/.55)}
[data-socrate="toolbar"] button[aria-pressed="true"] [data-label],[data-socrate="toolbar"][data-compact] [data-label]{display:none}
[data-socrate="toolbar"][data-compact] button:has([data-label]){padding:0}
[data-socrate="toolbar"] [data-sep]{flex:none;width:1px;height:20px;margin:0 4px;background:#e4e4e7}
[data-socrate] button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
[data-socrate="resize"]:focus-visible{outline:none}
[data-socrate="toolbar"] svg,[data-socrate="note"] svg{flex:none;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
[data-socrate="toolbar"] [data-count]{min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#2563eb;color:#fff;font-size:11px;line-height:18px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
[data-socrate="toolbar"] [data-socrate-action="draft"]{height:28px;background:#eff6ff;color:#1d4ed8;font-weight:600}
[data-socrate="toolbar"] [data-hint]{padding:0 8px 0 6px;color:#71717a}
[data-socrate="toolbar"][data-narrow] [data-hint],[data-socrate="toolbar"][data-narrow] [data-sep]{display:none}
[data-socrate="toolbar"][data-narrow] [data-socrate-action="draft"]{padding:0 8px}
@media (pointer:coarse){[data-socrate="toolbar"]{height:52px}[data-socrate="toolbar"] button{height:42px;min-width:42px}}
[data-socrate="menu"]{all:initial;position:fixed;z-index:2147483003;display:grid;min-width:200px;padding:4px;border-radius:10px;background:#fff;color:#09090b;border:1px solid #e4e4e7;box-shadow:0 10px 24px -6px rgb(0 0 0/.16),0 2px 4px rgb(0 0 0/.04);font:13px/18px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
[data-socrate="menu"] button{justify-content:flex-start;gap:8px;border-radius:6px;padding:0 8px;min-height:32px;height:auto}
[data-socrate="menu"] button > span{display:grid;gap:2px;padding:6px 0}
[data-socrate="menu"] small{font-size:12px;line-height:16px;color:#71717a}
[data-socrate="menu"] button[role="menuitemcheckbox"]::before{content:"";flex:none;width:14px;height:14px;box-sizing:border-box;border:1px solid #a1a1aa;border-radius:4px}
[data-socrate="menu"] button[aria-checked="true"]::before{border-color:#18181b;background:#18181b url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/10px no-repeat}
[data-socrate="menu"] button:hover:not([aria-disabled="true"]),[data-socrate="menu"] button:focus-visible{background:#f4f4f5;outline:none}
[data-socrate="menu"] button[aria-disabled="true"]{color:#a1a1aa;cursor:default}
[data-socrate="note"]{all:initial;position:fixed;bottom:calc(72px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483001;box-sizing:border-box;display:flex;align-items:flex-start;gap:4px;width:max-content;max-width:min(380px,calc(100vw - 32px));padding:10px 6px 10px 12px;border-radius:10px;background:#fff;color:#09090b;border:1px solid #e4e4e7;box-shadow:0 10px 24px -6px rgb(0 0 0/.16);font:13px/18px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
[data-socrate="note"] button{all:unset;flex:none;color:#2563eb;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
[data-socrate="note"] button[data-socrate-action="note"]{display:grid;place-items:center;width:20px;height:20px;border-radius:6px;color:#71717a;text-decoration:none}
[data-socrate="note"] button[data-socrate-action="note"] svg{width:14px;height:14px}
[data-socrate="tip"]{all:initial;position:fixed;z-index:2147483004;max-width:240px;padding:4px 8px;border-radius:6px;background:#18181b;color:#fafafa;font:12px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 8px rgb(0 0 0/.16)}
[data-socrate="pin"]{all:initial;position:fixed;z-index:2147482999;box-sizing:border-box;display:grid;place-items:center;width:28px;height:28px;border-radius:50% 50% 50% 4px;border:2px solid #fff;box-shadow:0 1px 3px rgb(0 0 0/.24),0 0 0 1px rgb(0 0 0/.06);color:#fff;font:600 11px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:-.02em;cursor:pointer}
[data-socrate="pin"]::before{content:"";position:absolute;inset:-6px}
[data-socrate="pin"][data-state="resolved"]{opacity:.45}
[data-socrate="pin"][data-probable]{border:2px dashed #09090b}
[data-socrate="pin"]:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
[data-socrate="pin"] [data-count]{position:absolute;top:-7px;right:-9px;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;border-radius:8px;background:#fff;color:#09090b;font-size:10px;line-height:16px;text-align:center;box-shadow:0 0 0 1px rgb(0 0 0/.12)}
[data-socrate="resize"]{all:initial;position:fixed;top:0;z-index:2147483001;width:9px;height:100vh;cursor:col-resize;touch-action:none}
[data-socrate="resize"]::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:1px;background:transparent;transition:background .15s}
[data-socrate="resize"]:hover::after,[data-socrate="resize"]:focus-visible::after,[data-socrate="resize"][data-active]::after{width:2px;left:3.5px;background:#2563eb}
[data-socrate="resize"]::before{content:"";position:absolute;top:50%;left:2px;width:5px;height:28px;margin-top:-14px;border-radius:3px;background:#d4d4d8;opacity:0;transition:opacity .15s}
[data-socrate="resize"]:hover::before,[data-socrate="resize"]:focus-visible::before{opacity:1}
`;
