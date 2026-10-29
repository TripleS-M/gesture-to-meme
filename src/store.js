// Meme + sample persistence: localStorage, plus JSON export/import.
const KEY = 'meme-mirror:v1';
export const MAX_RECORDED = 5;

export const DISPLAY_MODES = {
  panel: 'Side panel',
  'overlay-above-head': 'Above head',
  'overlay-on-face': 'On face',
  fullscreen: 'Fullscreen',
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meme';

export function newMeme({ id, name, image }) {
  return {
    id, name, image,
    mode: 'overlay-above-head',
    threshold: 0.7,
    offsetX: 0, offsetY: 0, scale: 1.3, opacity: 1,
    analyzed: false, // auto-import has been attempted
    confirmed: false, // the user verified it triggers
    samples: [], // { kind: 'auto' | 'recorded', feature, t }
  };
}

/** auto | recorded | needs-recording | pending */
export function memeStatus(m) {
  if (m.samples.some((s) => s.kind === 'recorded')) return 'recorded';
  if (m.samples.length) return 'auto';
  return m.analyzed ? 'needs-recording' : 'pending';
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.memes = [];
    this.deletedIds = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (data) {
        this.memes = data.memes || [];
        this.deletedIds = data.deletedIds || [];
      }
    } catch (e) {
      console.warn('Could not read saved data', e);
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ memes: this.memes, deletedIds: this.deletedIds }));
      return true;
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'Could not save: browser storage is full. Export your data and remove some memes.' }));
      return false;
    }
  }

  emit() { this.dispatchEvent(new Event('change')); }
  get(id) { return this.memes.find((m) => m.id === id); }

  uniqueId(base) {
    let id = slug(base), n = 2;
    while (this.get(id)) id = `${slug(base)}-${n++}`;
    return id;
  }

  add({ id, name, image }) {
    const meme = newMeme({ id: id ? id : this.uniqueId(name), name, image });
    this.memes.push(meme);
    this.save(); this.emit();
    return meme;
  }

  /** Patch settings. `silent` skips the re-render (used while dragging sliders). */
  update(id, patch, { silent = false } = {}) {
    const m = this.get(id);
    if (!m) return;
    Object.assign(m, patch);
    this.save();
    if (!silent) this.emit();
  }

  remove(id) {
    const m = this.get(id);
    if (!m) return;
    this.memes = this.memes.filter((x) => x.id !== id);
    if (!m.image.startsWith('data:') && !this.deletedIds.includes(id)) this.deletedIds.push(id);
    this.save(); this.emit();
  }

  setAuto(id, feature) {
    const m = this.get(id);
    m.analyzed = true;
    m.samples = m.samples.filter((s) => s.kind !== 'auto');
    if (feature) m.samples.unshift({ kind: 'auto', feature, t: Date.now() });
    this.save(); this.emit();
  }

  /** Add a recorded sample. `replace` drops earlier recordings (re-record). */
  addRecorded(id, feature, { replace = false } = {}) {
    const m = this.get(id);
    if (replace) m.samples = m.samples.filter((s) => s.kind !== 'recorded');
    const rec = m.samples.filter((s) => s.kind === 'recorded');
    if (rec.length >= MAX_RECORDED) m.samples.splice(m.samples.indexOf(rec[0]), 1);
    m.samples.push({ kind: 'recorded', feature, t: Date.now() });
    m.analyzed = true;
    this.save(); this.emit();
  }

  clearRecorded(id) {
    const m = this.get(id);
    m.samples = m.samples.filter((s) => s.kind !== 'recorded');
    m.confirmed = false;
    this.save(); this.emit();
  }

  /** Merge memes found in memes.json / the generated manifest. Existing memes keep their data. */
  sync(entries) {
    let changed = false;
    for (const e of entries) {
      const id = e.id || slug(e.name || e.image);
      const existing = this.get(id);
      if (existing) {
        if (e.name && existing.name === id.replace(/-/g, ' ') && e.name !== existing.name) {
          existing.name = e.name; changed = true;
        }
        continue;
      }
      if (this.deletedIds.includes(id)) continue;
      this.memes.push(newMeme({ id, name: e.name || id, image: e.image }));
      changed = true;
    }
    if (changed) { this.save(); this.emit(); }
  }

  exportJSON() {
    return JSON.stringify({ app: 'meme-mirror', version: 1, memes: this.memes, deletedIds: this.deletedIds }, null, 1);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    if (data.app !== 'meme-mirror' || !Array.isArray(data.memes)) throw new Error('Not a Meme Mirror export file.');
    for (const m of data.memes) {
      const merged = { ...newMeme(m), ...m };
      const i = this.memes.findIndex((x) => x.id === m.id);
      if (i >= 0) this.memes[i] = merged; else this.memes.push(merged);
    }
    this.deletedIds = [...new Set([...this.deletedIds, ...(data.deletedIds || [])])]
      .filter((id) => !this.get(id));
    this.save(); this.emit();
    return data.memes.length;
  }
}
