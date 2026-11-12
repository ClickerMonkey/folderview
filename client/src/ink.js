// Images: zoom, swipe to the next or previous file, earlier comments' marks drawn over the picture, and drawing by
// hand to comment on an area (the marks, the area they cover, and a marked-up copy go to the review folder).
import { on, toast } from './util.js';
import { commentsOn, state } from './state.js';
import { icon } from './icons.js';
import { areaNumber, composerHtml } from './review.js';

/** the image on screen now */
let cur = null;
const INK = '#ff2d55';

export function wireImage({ path, stage, pic, tools, step }) {
  const me = { path, stage, pic, tools, wrap: stage.querySelector('.picwrap'), strokes: [], drawing: false, canvas: null };
  cur = me;
  paintTools(me);
  pic.onclick = () => {
    if (!me.drawing) stage.classList.toggle('actual');
  };
  // a sideways swipe opens the next (swipe left) or previous (swipe right) file
  let start = null;
  stage.addEventListener(
    'touchstart',
    (e) => {
      start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
    },
    { passive: true },
  );
  stage.addEventListener('touchend', (e) => {
    const s = start;
    start = null;
    if (!s || me.drawing || stage.classList.contains('actual') || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - s.x,
      dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && Date.now() - s.t < 800) step(dx < 0 ? 1 : -1);
  });
  tools.onclick = (e) => {
    const b = e.target.closest('[data-ink]');
    if (!b) return;
    const act = b.dataset.ink;
    if (act === 'start') startDrawing(me);
    else if (act === 'undo') {
      me.strokes.pop();
      drawInk(me);
    } else if (act === 'clear') {
      me.strokes = [];
      drawInk(me);
    } else if (act === 'cancel') stopDrawing(me);
  };
  paintMarks();
}

function paintTools(me) {
  const ro = state.info.readOnly;
  const touch = matchMedia('(pointer: coarse)').matches;
  me.tools.innerHTML = me.drawing
    ? `<span class="ink-hint">${icon('pen', 14)} Draw on the picture around what you mean, then say what should change.</span><span class="grow"></span><button class="btn small" data-ink="undo">${icon('undo', 14)} Undo</button><button class="btn small" data-ink="clear">Clear</button><button class="btn small" data-ink="cancel">Cancel</button>`
    : `${ro ? '' : `<button class="btn small" data-ink="start">${icon('pen', 14)} Mark an area</button>`}<span class="faint hint">${touch ? 'Tap to zoom · swipe for the next file' : 'Click to see it at full size'}</span>`;
}

function startDrawing(me) {
  if (me.drawing) return;
  me.drawing = true;
  me.strokes = [];
  me.stage.classList.remove('actual');
  me.wrap.classList.add('drawing');
  const c = document.createElement('canvas');
  c.className = 'ink';
  me.wrap.append(c);
  me.canvas = c;
  let stroke = null;
  const pt = (e) => {
    const r = c.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  c.onpointerdown = (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    stroke = [...pt(e)];
    me.strokes.push(stroke);
    drawInk(me);
  };
  c.onpointermove = (e) => {
    if (!stroke) return;
    const [x, y] = pt(e);
    const lx = stroke[stroke.length - 2],
      ly = stroke[stroke.length - 1];
    if (Math.hypot(x - lx, y - ly) < 0.002) return;
    stroke.push(x, y);
    drawInk(me);
  };
  c.onpointerup = c.onpointercancel = () => (stroke = null);
  paintTools(me);
  // the comment box, under the tools
  me.tools.insertAdjacentHTML('afterend', composerHtml(me.path, 0, 0));
  const f = me.tools.nextElementSibling;
  f.classList.add('ink-composer');
  f.querySelector('.composer-head').firstChild.textContent = 'Comment on the marked area ';
  f.getMarks = () => marks(me);
  new ResizeObserver(() => drawInk(me)).observe(c);
  drawInk(me);
}

function stopDrawing(me) {
  if (!me.drawing) return;
  me.drawing = false;
  me.canvas?.remove();
  me.canvas = null;
  me.strokes = [];
  me.wrap.classList.remove('drawing');
  me.tools.parentElement?.querySelector('.ink-composer')?.remove();
  paintTools(me);
}

on('composer-closed', () => {
  if (cur?.drawing && !cur.tools.parentElement?.querySelector('.ink-composer')) stopDrawing(cur);
});

function drawInk(me) {
  const c = me.canvas;
  if (!c) return;
  const r = c.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  const g = c.getContext('2d');
  strokeAll(g, me.strokes, c.width, c.height, 3 * dpr);
}

function strokeAll(g, strokes, w, h, width) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [color, lw] of [
    ['rgba(255,255,255,.85)', width * 2],
    [INK, width],
  ]) {
    g.strokeStyle = color;
    g.lineWidth = lw;
    for (const s of strokes) {
      g.beginPath();
      g.moveTo(s[0] * w, s[1] * h);
      if (s.length === 2) g.lineTo(s[0] * w + 0.1, s[1] * h);
      for (let i = 2; i < s.length; i += 2) g.lineTo(s[i] * w, s[i + 1] * h);
      g.stroke();
    }
  }
}

/** what the comment carries: the strokes, the area they cover in the image's pixels, and a marked-up copy */
async function marks(me) {
  if (!me.strokes.length) {
    toast('Draw on the picture first');
    return null;
  }
  const img = me.pic;
  const W0 = img.naturalWidth || img.clientWidth * 2,
    H0 = img.naturalHeight || img.clientHeight * 2;
  let x0 = 1,
    y0 = 1,
    x1 = 0,
    y1 = 0;
  for (const s of me.strokes)
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]);
      x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]);
      y1 = Math.max(y1, s[i + 1]);
    }
  const pad = 0.01;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(1, x1 + pad);
  y1 = Math.min(1, y1 + pad);
  const out = {
    strokes: me.strokes.map((s) => s.map((v) => Math.round(v * 10000) / 10000)),
    area: { x: Math.round(x0 * W0), y: Math.round(y0 * H0), w: Math.max(1, Math.round((x1 - x0) * W0)), h: Math.max(1, Math.round((y1 - y0) * H0)) },
  };
  try {
    const k = Math.min(1, 2048 / Math.max(W0, H0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W0 * k));
    c.height = Math.max(1, Math.round(H0 * k));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    strokeAll(g, out.strokes, c.width, c.height, Math.max(3, c.width / 250));
    out.snapshot = c.toDataURL('image/png');
  } catch {
    // a picture the browser won't read back: the marks and area still go
  }
  return out;
}

/** draw earlier comments' marks over the picture, each with its number */
export function paintMarks() {
  const me = cur;
  if (!me || !me.wrap.isConnected) return;
  const svg = me.wrap.querySelector('.marks');
  const pins = me.wrap.querySelector('.pins');
  const list = commentsOn(me.path).filter((c) => c.strokes?.length && (state.settings.resolved || c.status === 'open'));
  svg.innerHTML = list
    .map((c) => c.strokes.map((s) => `<polyline class="${c.status}" points="${pairs(s)}"/>`).join(''))
    .join('');
  pins.innerHTML = list
    .map((c) => `<button class="pin ${c.status}" data-pin="${c.id}" style="left:${c.strokes[0][0] * 100}%;top:${c.strokes[0][1] * 100}%" title="Marked area ${areaNumber(c)}" aria-label="Marked area ${areaNumber(c)}">${areaNumber(c)}</button>`)
    .join('');
  pins.onclick = (e) => {
    const b = e.target.closest('[data-pin]');
    const t = b && document.querySelector(`#file-threads [data-cid="${b.dataset.pin}"]`);
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
  };
}

const pairs = (s) => {
  const o = [];
  for (let i = 0; i < s.length; i += 2) o.push(`${s[i]},${s[i + 1]}`);
  if (o.length === 1) o.push(o[0]);
  return o.join(' ');
};
