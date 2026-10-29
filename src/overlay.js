// Draws debug landmarks and meme overlays on a canvas layered over the (CSS-mirrored) video.
// The canvas itself is not mirrored, so every x is flipped here (x -> 1 - x) to match what the user sees.
import { CONNECTIONS } from './landmarkers.js';

const FADE_MS = 150;
const SMOOTH = 0.35;

const images = new Map();
export function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    }));
  }
  return images.get(src);
}

export class OverlayRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.states = new Map(); // meme id -> { alpha, x, y, size, angle, init }
    this.loaded = new Map(); // src -> HTMLImageElement
    this.lastFace = null;
    this.lastT = performance.now();
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  image(src) {
    const img = this.loaded.get(src);
    if (!img && !this.loaded.has(src)) {
      this.loaded.set(src, null);
      loadImage(src).then((i) => this.loaded.set(src, i)).catch(() => {});
    }
    return img;
  }

  render({ raw, memes, activeId, showLandmarks }) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const now = performance.now();
    const dt = now - this.lastT;
    this.lastT = now;
    ctx.clearRect(0, 0, W, H);

    if (raw?.face) this.lastFace = raw.face.landmarks;
    else if (!raw) this.lastFace = null;
    if (showLandmarks && raw) this.drawLandmarks(raw, W, H);

    for (const m of memes) {
      const st = this.states.get(m.id) || { alpha: 0, init: false };
      this.states.set(m.id, st);
      const target = m.id === activeId && m.mode !== 'panel' ? 1 : 0;
      st.alpha += Math.sign(target - st.alpha) * Math.min(Math.abs(target - st.alpha), dt / FADE_MS);
      if (st.alpha <= 0) { st.init = false; continue; }
      const img = this.image(m.image);
      if (!img) continue;
      ctx.save();
      ctx.globalAlpha = st.alpha * (m.opacity ?? 1);
      this.drawMeme(m, img, st, W, H);
      ctx.restore();
    }
  }

  drawMeme(m, img, st, W, H) {
    const { ctx } = this;
    const ar = img.naturalHeight / img.naturalWidth;
    if (m.mode === 'fullscreen') {
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, (W - w) / 2 + m.offsetX * W, (H - h) / 2 - m.offsetY * H, w, h);
      return;
    }
    const geo = this.faceGeometry(W, H);
    if (!geo) return; // no face to anchor to
    const above = m.mode === 'overlay-above-head';
    const target = {
      x: above ? geo.top.x : geo.center.x,
      y: above ? geo.top.y : geo.center.y,
      size: geo.width * m.scale,
      angle: geo.angle,
    };
    if (!st.init) { Object.assign(st, target, { init: true }); }
    else {
      for (const k of ['x', 'y', 'size', 'angle']) st[k] += (target[k] - st[k]) * SMOOTH;
    }
    const w = st.size, h = st.size * ar;
    const ox = m.offsetX * geo.width, oy = m.offsetY * geo.width;
    ctx.translate(st.x, st.y);
    ctx.rotate(st.angle);
    if (above) ctx.drawImage(img, -w / 2 + ox, -h - 0.1 * geo.width - oy, w, h);
    else ctx.drawImage(img, -w / 2 + ox, -h / 2 - oy, w, h);
  }

  /** Head position, width and roll in canvas (mirrored) coordinates. */
  faceGeometry(W, H) {
    const f = this.lastFace;
    if (!f) return null;
    const P = (i) => ({ x: (1 - f[i].x) * W, y: f[i].y * H });
    const top = P(10), chin = P(152), a = P(234), b = P(454);
    const e1 = P(33), e2 = P(263);
    let angle = Math.atan2(e2.y - e1.y, e2.x - e1.x);
    if (e2.x < e1.x) angle += Math.PI; // mirrored: eye order flips
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    return {
      top,
      center: { x: (top.x + chin.x) / 2, y: (top.y + chin.y) / 2 },
      width: Math.hypot(a.x - b.x, a.y - b.y),
      angle,
    };
  }

  drawLandmarks(raw, W, H) {
    const { ctx } = this;
    const pt = (p) => [(1 - p.x) * W, p.y * H];
    const draw = (lm, conns, color, r) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const c of conns) {
        if (!lm[c.start] || !lm[c.end]) continue;
        const [x1, y1] = pt(lm[c.start]), [x2, y2] = pt(lm[c.end]);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      if (r) for (const p of lm) { const [x, y] = pt(p); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
    };
    ctx.globalAlpha = 0.9;
    if (raw.face) draw(raw.face.landmarks, CONNECTIONS.face, '#7dd3fc', 0);
    if (raw.pose) draw(raw.pose.landmarks, CONNECTIONS.pose, '#fbbf24', 0);
    for (const h of raw.hands) draw(h.landmarks, CONNECTIONS.hand, '#4ade80', 3);
    ctx.globalAlpha = 1;
  }
}
