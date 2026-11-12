// Mermaid diagrams, as the harness web app draws them: mermaid is loaded the first time a diagram is drawn, set to
// `strict` (no scripts, no clicks, labels as text) and given the page's own font and colours, light or dark. The SVG
// is shown as an image from a blob URL, so nothing in a diagram can reach the page.

const SVG_ROOT = /<svg\b[^>]*>/;
const VIEW_BOX = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/;
const SIZE_ATTRIBUTES = /\s(?:width|height)="[^"]*"/g;

/** mermaid draws width="100%", which an <img> can't resolve: give the root its viewBox's size */
function sizedSvg(svg) {
  const root = SVG_ROOT.exec(svg)?.[0];
  const box = root && VIEW_BOX.exec(root);
  if (!root || !box) return svg;
  return svg.replace(root, root.replace(SIZE_ATTRIBUTES, '').replace(/^<svg/, `<svg width="${box[1]}" height="${box[2]}"`));
}

function hexOf(paint, probe, token) {
  probe.style.color = `var(${token})`;
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = getComputedStyle(probe).color;
  paint.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
  return a === 0 ? undefined : '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function look() {
  const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!paint) return undefined;
  const probe = document.createElement('span');
  document.body.append(probe);
  try {
    const [background, surface, border, text, muted, accent] = ['--bg', '--surface-2', '--border-strong', '--text', '--text-dim', '--accent'].map((t) => hexOf(paint, probe, t));
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
    if (!background || !surface || !border || !text || !muted || !accent) return undefined;
    return { font, background, surface, border, text, muted, accent };
  } finally {
    probe.remove();
  }
}

function themeOf(l, dark) {
  return {
    theme: 'base',
    fontFamily: l.font,
    themeVariables: {
      darkMode: dark,
      fontFamily: l.font,
      fontSize: '14px',
      background: l.background,
      primaryColor: l.surface,
      primaryBorderColor: l.border,
      primaryTextColor: l.text,
      secondaryColor: l.surface,
      secondaryBorderColor: l.border,
      secondaryTextColor: l.text,
      tertiaryColor: l.background,
      tertiaryBorderColor: l.border,
      tertiaryTextColor: l.text,
      mainBkg: l.surface,
      nodeBorder: l.border,
      nodeTextColor: l.text,
      lineColor: l.muted,
      textColor: l.text,
      clusterBkg: l.background,
      clusterBorder: l.border,
      edgeLabelBackground: l.background,
      titleColor: l.text,
      noteBkgColor: l.surface,
      noteBorderColor: l.accent,
      noteTextColor: l.text,
      actorBorder: l.border,
      actorBkg: l.surface,
    },
  };
}

let mermaid;
let queue = Promise.resolve();
let count = 0;
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches ? document.documentElement.dataset.theme !== 'light' : document.documentElement.dataset.theme === 'dark';

/** Draw mermaid source: { ok: true, svg } or { ok: false, problem }. One at a time (mermaid's theme is global). */
export function renderDiagram(source) {
  const drawn = queue.then(async () => {
    mermaid ??= import('mermaid').then((m) => m.default);
    const m = await mermaid;
    const l = look();
    const dark = isDark();
    m.initialize({ startOnLoad: false, securityLevel: 'strict', ...(l ? themeOf(l, dark) : { theme: dark ? 'dark' : 'default' }) });
    try {
      const { svg } = await m.render(`codeview-diagram-${++count}`, source);
      return { ok: true, svg: sizedSvg(svg) };
    } catch (e) {
      document.getElementById(`dcodeview-diagram-${count}`)?.remove(); // mermaid leaves its error drawing behind
      return { ok: false, problem: e instanceof Error ? e.message : String(e) };
    }
  });
  queue = drawn.catch(() => undefined);
  return drawn;
}

/** Fill a host element with the diagram, as an image (click opens it full size). */
export async function drawInto(host, source) {
  host.innerHTML = '<div class="skeleton" style="width:60%;height:120px"></div>';
  const r = await renderDiagram(source);
  if (!r.ok) {
    host.innerHTML = `<p class="problem">This diagram couldn't be drawn: ${escapeText(r.problem)}</p>`;
    return;
  }
  const url = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }));
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Diagram';
  img.onclick = () => window.open(url, '_blank', 'noopener');
  // fit the width when shrinking keeps it readable; a much wider diagram scrolls sideways at a smaller size
  img.onload = () => {
    const room = host.clientWidth - 26;
    const w = img.naturalWidth;
    if (w > room) img.style.width = (w <= room * 1.8 ? room : Math.round(w * 0.6)) + 'px';
  };
  host.replaceChildren(img);
}

const escapeText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
