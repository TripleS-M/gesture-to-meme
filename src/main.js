import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/syne/700.css';
import '@fontsource/syne/800.css';
import '@fontsource/fragment-mono/400.css';
import './styles.css';
import seed from '../memes.json';
import { startCamera, describeCameraError } from './camera.js';
import { Landmarkers } from './landmarkers.js';
import { extractFeatures, hasPerson, isDistinctive, averageFeatures, Smoother, roundFeature } from './features.js';
import { Matcher } from './matcher.js';
import { Store } from './store.js';
import { OverlayRenderer, loadImage } from './overlay.js';
import { UI, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
const RECORD_FRAMES = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class App {
  constructor() {
    this.video = $('video');
    this.store = new Store();
    this.lm = new Landmarkers();
    this.matcher = new Matcher();
    this.smoother = new Smoother(4);
    this.overlay = new OverlayRenderer($('overlay'));
    this.showLandmarks = false;
    this.cameraReady = false;
    this.modelsReady = false;
    this.fps = 0;
    this.live = null;
    this.state = { ranked: [], best: null, valid: false, candidateId: null, activeId: null };
    this.collector = null;
    this.recording = null;
    this.analysisChain = Promise.resolve();
    this.lastVideoTime = -1;
    this.frames = 0;
    this.fpsStart = performance.now();
    this.slowSeconds = 0;
    this.fastSeconds = 0;
    this.ui = new UI(this);
  }

  setStatus(text, cls = 'chip') {
    const chip = $('statusChip');
    chip.textContent = text;
    chip.className = cls;
  }

  async start() {
    await this.syncMemes();
    this.setStatus('Loading models…');
    const modelsLoaded = this.lm.init((msg) => this.setStatus(msg))
      .then(() => { this.modelsReady = true; })
      .catch((e) => {
        console.error(e);
        this.setStatus('Could not load models. Run "npm run setup".', 'chip warn');
        toast('Model files missing or failed to load. Run "npm run setup" once (needs internet), then reload.', true);
        throw e;
      });
    await Promise.allSettled([this.startCamera(), modelsLoaded]);
    if (!this.modelsReady) return;
    this.analyzePending();
    requestAnimationFrame(() => this.tick());
  }

  async startCamera() {
    $('cameraError').hidden = true;
    this.setStatus('Starting camera…');
    try {
      await startCamera(this.video);
      this.cameraReady = true;
      this.overlay.resize(this.video.videoWidth, this.video.videoHeight);
      $('stage').style.aspectRatio = `${this.video.videoWidth} / ${this.video.videoHeight}`;
      this.setStatus('Camera ready');
      if (this.modelsReady && !this.looping) requestAnimationFrame(() => this.tick());
    } catch (e) {
      this.cameraReady = false;
      $('cameraErrorText').textContent = describeCameraError(e);
      $('cameraError').hidden = false;
      this.setStatus('No camera', 'chip warn');
    }
  }

  async syncMemes() {
    let manifest = [];
    try {
      const res = await fetch(`${BASE}memes-manifest.json`, { cache: 'no-store' });
      if (res.ok && (res.headers.get('content-type') || '').includes('json')) manifest = await res.json();
    } catch { /* optional */ }
    const entries = [...seed, ...manifest.filter((m) => !seed.some((s) => s.id === m.id))]
      .map((m) => ({ ...m, image: /^(data:|https?:|\/)/.test(m.image) ? m.image : BASE + m.image }));
    this.store.sync(entries);
  }

  // --- image auto-import ----------------------------------------------------------------
  /** Extract a reference pose from the meme's image. Serialised so models are created once. */
  analyzeMeme(meme) {
    const job = this.analysisChain.then(async () => {
      while (!this.modelsReady) await sleep(200);
      try {
        const img = await loadImage(meme.image);
        const max = 1024;
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = Object.assign(document.createElement('canvas'), {
          width: Math.max(1, Math.round(img.naturalWidth * s)), height: Math.max(1, Math.round(img.naturalHeight * s)),
        });
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const raw = await this.lm.detectImage(c);
        const f = extractFeatures(raw, c.width / c.height);
        this.store.setAuto(meme.id, isDistinctive(f) ? roundFeature(f) : null);
      } catch (e) {
        console.warn('analysis failed for', meme.name, e);
        this.store.setAuto(meme.id, null);
      }
    });
    this.analysisChain = job.catch(() => {});
    return job;
  }

  async analyzePending() {
    const pending = this.store.memes.filter((m) => !m.analyzed);
    if (!pending.length) return;
    for (const [i, m] of pending.entries()) {
      this.setStatus(`Analysing memes ${i + 1}/${pending.length}…`);
      await this.analyzeMeme(m);
    }
    if (this.cameraReady) this.setStatus('Camera ready');
    toast(`Analysed ${pending.length} meme(s). Open “Setup wizard” to confirm them.`);
  }

  // --- recording -------------------------------------------------------------------------
  cancelRecording() { if (this.recording) this.recording.cancelled = true; }

  /** 3-2-1 countdown, then average ~15 frames into a sample. Resolves to a feature or null. */
  async record(title, { wizard = false } = {}) {
    if (!this.cameraReady || !this.modelsReady) { toast('Camera and models must be ready first.', true); return null; }
    if (this.recording) return null;
    const token = this.recording = { cancelled: false };
    const box = wizard ? $('wizardRecord') : $('recordOverlay');
    const count = wizard ? $('wizardCount') : $('recordCount');
    const bar = wizard ? $('wizardBar') : $('recordBar');
    if (!wizard) $('recordTitle').textContent = `${title}: strike the pose`;
    box.hidden = false;
    bar.style.width = '0';
    const done = () => { box.hidden = true; this.recording = null; this.collector = null; };
    try {
      for (let n = 3; n >= 1; n--) {
        count.textContent = n;
        await sleep(1000);
        if (token.cancelled) return done(), null;
      }
      count.textContent = '●';
      const frames = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(this.collector.frames), 6000);
        this.collector = {
          frames: [],
          onFrame: (n) => {
            bar.style.width = `${(n / RECORD_FRAMES) * 100}%`;
            if (n >= RECORD_FRAMES) { clearTimeout(timeout); resolve(this.collector.frames); }
          },
        };
      });
      if (token.cancelled) return done(), null;
      const avg = frames.length >= 8 ? averageFeatures(frames) : null;
      done();
      if (!avg) { toast('No person detected while recording. Make sure you are in view and try again.', true); return null; }
      if (!isDistinctive(avg)) toast('No hands or strong expression seen. This pose may trigger by accident; consider re-recording.', true);
      return roundFeature(avg);
    } catch (e) {
      done();
      throw e;
    }
  }

  // --- wizard camera preview ---------------------------------------------------------------
  drawMirror(canvas) {
    if (!this.cameraReady) return;
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, -w, 0, w, h);
    ctx.restore();
    if (this.showLandmarks && this.lastRaw) {
      ctx.save();
      const o = this.overlay;
      const saved = [o.ctx, o.canvas];
      o.ctx = ctx; o.canvas = canvas;
      o.drawLandmarks(this.lastRaw, w, h);
      [o.ctx, o.canvas] = saved;
      ctx.restore();
    }
  }

  // --- render loop ---------------------------------------------------------------------------
  tick() {
    this.looping = true;
    requestAnimationFrame(() => this.tick());
    const v = this.video;
    if (!this.cameraReady || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();

    const raw = this.lm.detectVideo(v);
    this.lastRaw = raw;
    const aspect = v.videoWidth / v.videoHeight;
    const feat = extractFeatures(raw, aspect);
    const person = hasPerson(feat);
    this.live = this.smoother.push(feat);

    if (this.collector && person) {
      this.collector.frames.push(feat);
      this.collector.onFrame(this.collector.frames.length);
    }

    this.state = this.matcher.update(this.store.memes, this.live, now);
    this.overlay.resize(v.videoWidth, v.videoHeight);
    this.overlay.render({
      raw: person ? raw : null,
      memes: this.store.memes,
      activeId: this.state.activeId,
      showLandmarks: this.showLandmarks,
    });
    this.ui.frame({ live: this.live, state: this.state, hasPerson: person, raw });
    this.trackFps(now);
  }

  /** Measure FPS once a second; back off the heavy models when below 20 fps, recover when comfortable. */
  trackFps(now) {
    this.frames++;
    if (now - this.fpsStart < 1000) return;
    this.fps = (this.frames * 1000) / (now - this.fpsStart);
    this.frames = 0;
    this.fpsStart = now;
    if (this.fps < 20) { this.slowSeconds++; this.fastSeconds = 0; } else if (this.fps > 27) { this.fastSeconds++; this.slowSeconds = 0; } else { this.slowSeconds = this.fastSeconds = 0; }
    if (this.slowSeconds >= 2) { this.lm.setLevel(this.lm.level + 1); this.slowSeconds = 0; }
    if (this.fastSeconds >= 8) { this.lm.setLevel(this.lm.level - 1); this.fastSeconds = 0; }
  }
}

const app = new App();
window.memeMirror = app; // handy for debugging in the console
app.start();
