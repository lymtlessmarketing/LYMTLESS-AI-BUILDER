import type { Sandbox } from "@vercel/sandbox";
import { SANDBOX_ROOT, runCaptured } from "@/lib/sandbox/build";

const BRIDGE_PATH = `${SANDBOX_ROOT}/public/lymtless-editor-bridge.js`;
const SCRIPT_TAG = '<script src="/lymtless-editor-bridge.js"></script>';

export async function installSelectionBridge(sandbox: Sandbox) {
  const mkdir = await runCaptured(sandbox, "mkdir", ["-p", `${SANDBOX_ROOT}/public`]);
  if (mkdir.exitCode !== 0) throw new Error(`Could not prepare Select & Edit bridge directory: ${mkdir.combined}`);

  await sandbox.writeFiles([
    { path: BRIDGE_PATH, content: Buffer.from(selectionBridgeScript(), "utf8") },
  ]);

  const patchScript = `
const fs = require('node:fs');
const file = ${JSON.stringify(`${SANDBOX_ROOT}/index.html`)};
const tag = ${JSON.stringify(SCRIPT_TAG)};
let html = fs.readFileSync(file, 'utf8');
if (!html.includes('/lymtless-editor-bridge.js')) {
  if (/<\\/body>/i.test(html)) html = html.replace(/<\\/body>/i, tag + '\\n</body>');
  else html += '\\n' + tag + '\\n';
  fs.writeFileSync(file, html, 'utf8');
}
`;
  const patch = await runCaptured(sandbox, "node", ["-e", patchScript]);
  if (patch.exitCode !== 0) throw new Error(`Could not inject Select & Edit bridge: ${patch.combined}`);
}

function selectionBridgeScript() {
  return `
(() => {
  if (window.__LYMTLESS_EDITOR_BRIDGE__) return;
  window.__LYMTLESS_EDITOR_BRIDGE__ = true;

  let enabled = false;
  let active = null;
  const overlay = document.createElement('div');
  overlay.setAttribute('data-lymtless-editor-overlay', 'true');
  Object.assign(overlay.style, {
    position: 'fixed',
    zIndex: '2147483647',
    pointerEvents: 'none',
    border: '2px solid #2563eb',
    background: 'rgba(37, 99, 235, 0.08)',
    borderRadius: '4px',
    boxSizing: 'border-box',
    display: 'none',
  });
  document.documentElement.appendChild(overlay);

  const send = (event, payload = {}) => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'LYMTLESS_EDITOR_EVENT', event, payload }, '*');
  };

  const clean = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const safeClasses = (element) => Array.from(element.classList || []).filter((name) => /^[A-Za-z0-9_-]{1,80}$/.test(name)).slice(0, 12);

  const nodeLabel = (element) => ({
    tag: element.tagName.toLowerCase(),
    id: clean(element.id, 120) || null,
    classes: safeClasses(element),
  });

  const selectorFor = (element) => {
    if (element.id && /^[A-Za-z][A-Za-z0-9_:.-]*$/.test(element.id)) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      const classes = safeClasses(current).slice(0, 2);
      if (classes.length) part += classes.map((name) => '.' + CSS.escape(name)).join('');
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ').slice(0, 1000);
  };

  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const ancestors = [];
    let parent = element.parentElement;
    while (parent && ancestors.length < 5 && parent !== document.documentElement) {
      ancestors.push(nodeLabel(parent));
      parent = parent.parentElement;
    }
    return {
      tag: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      text: clean(element.innerText || element.textContent || '', 320),
      id: clean(element.id, 120) || null,
      classes: safeClasses(element),
      role: clean(element.getAttribute('role'), 80) || null,
      ariaLabel: clean(element.getAttribute('aria-label'), 160) || null,
      name: clean(element.getAttribute('name'), 120) || null,
      inputType: element instanceof HTMLInputElement ? clean(element.type, 40) : null,
      sourceHint: clean(element.getAttribute('data-lymtless-source'), 240) || null,
      route: clean(location.pathname, 300) || '/',
      ancestors,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };

  const draw = (element) => {
    if (!enabled || !element || element === overlay || element.closest('[data-lymtless-editor-overlay]')) {
      overlay.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
  };

  const onPointerMove = (event) => {
    if (!enabled) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element === overlay) return;
    active = element;
    draw(element);
  };

  const onClick = (event) => {
    if (!enabled) return;
    const element = event.target instanceof Element ? event.target : active;
    if (!element || element === overlay) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    draw(element);
    send('selected', describe(element));
  };

  const setEnabled = (next) => {
    enabled = Boolean(next);
    document.documentElement.style.cursor = enabled ? 'crosshair' : '';
    if (!enabled) {
      active = null;
      overlay.style.display = 'none';
    }
    send('mode', { enabled });
  };

  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('scroll', () => { if (enabled && active) draw(active); }, true);
  window.addEventListener('resize', () => { if (enabled && active) draw(active); });
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'LYMTLESS_EDITOR_COMMAND') return;
    if (data.command === 'set-mode') setEnabled(data.enabled);
    if (data.command === 'ping') send('ready', { enabled });
  });

  send('ready', { enabled: false });
})();
`;
}
