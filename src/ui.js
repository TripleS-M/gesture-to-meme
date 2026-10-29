// DOM UI: meme library, import, recording overlay, test mode, setup wizard.
import { DISPLAY_MODES, memeStatus, MAX_RECORDED } from './store.js';
import { memeDistance, findConflicts } from './matcher.js';

const $ = (id) => document.getElementById(id);
const BADGE = { auto: 'auto', recorded: 'recorded', 'needs-recording': 'needs recording', pending: 'analysing…' };

let toastTimer;
export function toast(msg, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2800);
}

function sliderRow(label, min, max, step, value, onInput, fmt = (v) => v.toFixed(2)) {
  const row = document.createElement('label');
  row.className = 'row';
  const out = document.createElement('output');
  const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value });
  out.textContent = fmt(+value);
  input.oninput = () => { out.textContent = fmt(+input.value); onInput(+input.value); };
  row.append(label, input, out);
  return row;
}

function modeSelect(meme, store, onChange) {
  const sel = document.createElement('select');
  for (const [v, l] of Object.entries(DISPLAY_MODES)) sel.add(new Option(l, v, false, v === meme.mode));
  sel.onchange = () => { store.update(meme.id, { mode: sel.value }, { silent: true }); onChange?.(); };
  return sel;
}

function advancedSliders(meme, store) {
  const s = (patch) => store.update(meme.id, patch, { silent: true });
  return [
    sliderRow('Offset X', -1, 1, 0.01, meme.offsetX, (v) => s({ offsetX: v })),
    sliderRow('Offset Y', -1, 1, 0.01, meme.offsetY, (v) => s({ offsetY: v })),
    sliderRow('Scale', 0.3, 3, 0.05, meme.scale, (v) => s({ scale: v })),
    sliderRow('Opacity', 0.1, 1, 0.05, meme.opacity, (v) => s({ opacity: v })),
  ];
}

export class UI {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.cards = new Map();
    this.wizard = null;
    this.bind();
    this.store.addEventListener('change', () => this.renderList());
    this.store.addEventListener('error', (e) => toast(e.detail, true));
    this.renderList();
  }

  // --- static wiring ----------------------------------------------------------------
  bind() {
    const app = this.app;
    $('toggleLandmarks').onchange = (e) => { app.showLandmarks = e.target.checked; };
    $('toggleTest').onchange = (e) => { $('testPanel').hidden = !e.target.checked; };
    $('btnSetup').onclick = () => this.openWizard();
    $('btnExport').onclick = () => this.exportData();
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = (e) => this.importData(e.target.files[0]).finally(() => { e.target.value = ''; });
    $('btnRetryCamera').onclick = () => app.startCamera();
    $('btnAddMemes').onclick = () => $('memeFiles').click();
    $('memeFiles').onchange = (e) => { this.addFiles([...e.target.files]); e.target.value = ''; };

    const dz = $('dropzone');
    dz.onclick = () => $('memeFiles').click();
    for (const ev of ['dragenter', 'dragover']) {
      window.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) dz.classList.remove('over'); });
    }
    window.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) this.addFiles(files);
    });

    // wizard
    $('wizardClose').onclick = () => this.closeWizard();
    $('wizWorks').onclick = () => this.wizardWorks();
    $('wizRecord').onclick = () => this.wizardRecord();
    $('wizSkip').onclick = () => this.wizardSkip();
    window.addEventListener('keydown', (e) => {
      if (!this.wizard || e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === ' ') { e.preventDefault(); this.wizardRecord(); }
      else if (e.key === 'Enter') { e.preventDefault(); this.wizardWorks(); }
      else if (e.key === 's' || e.key === 'S') this.wizardSkip();
      else if (e.key === 'Escape') this.closeWizard();
    });
  }

  // --- import / export --------------------------------------------------------------
  async addFiles(files) {
    files = files.filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const bar = $('importBar'), text = $('importText');
    $('importProgress').hidden = false;
    const added = [];
    for (let i = 0; i < files.length; i++) {
      text.textContent = `Analysing ${i + 1} / ${files.length}: ${files[i].name}`;
      bar.style.width = `${(i / files.length) * 100}%`;
      try {
        const image = await fileToDataUrl(files[i]);
        const name = files[i].name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
        const meme = this.store.add({ name, image });
        await this.app.analyzeMeme(meme);
        added.push(meme);
      } catch (e) {
        console.error(e);
        toast(`Could not add ${files[i].name}`, true);
      }
    }
    bar.style.width = '100%';
    text.textContent = `Added ${added.length} meme(s).`;
    setTimeout(() => { $('importProgress').hidden = true; bar.style.width = '0'; }, 1800);
    const needWork = added.filter((m) => !m.confirmed).length;
    if (needWork) this.openWizard();
  }

  exportData() {
    const url = URL.createObjectURL(new Blob([this.store.exportJSON()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'meme-mirror.json' });
    a.click();
    URL.revokeObjectURL(url);
  }

  async importData(file) {
    if (!file) return;
    try {
      const n = this.store.importJSON(await file.text());
      toast(`Imported ${n} meme(s).`);
    } catch (e) {
      toast(`Import failed: ${e.message}`, true);
    }
  }

  // --- meme list ---------------------------------------------------------------------
  renderList() {
    const list = $('memeList');
    list.replaceChildren();
    this.cards.clear();
    for (const m of this.store.memes) {
      const card = this.buildCard(m);
      this.cards.set(m.id, card);
      list.append(card.el);
    }
    this.renderConflicts();
  }

  buildCard(m) {
    const store = this.store;
    const status = memeStatus(m);
    const el = document.createElement('div');
    el.className = 'card';
    const top = document.createElement('div');
    top.className = 'card-top';
    const thumb = Object.assign(document.createElement('img'), { className: 'thumb', src: m.image, alt: '' });
    const info = document.createElement('div');
    info.className = 'card-info';
    const name = Object.assign(document.createElement('input'), { className: 'card-name', value: m.name });
    name.onchange = () => store.update(m.id, { name: name.value.trim() || m.name }, { silent: true });
    const badges = document.createElement('div');
    badges.className = 'badges';
    const badge = Object.assign(document.createElement('span'), { className: `badge ${status}`, textContent: BADGE[status] });
    const rec = m.samples.filter((s) => s.kind === 'recorded').length;
    const count = document.createElement('span');
    count.textContent = `${m.samples.length} sample${m.samples.length === 1 ? '' : 's'}${rec ? ` (${rec} recorded)` : ''}`;
    badges.append(badge, count);
    info.append(name, badges);
    top.append(thumb, info);

    const thr = sliderRow('Threshold', 0.1, 2, 0.01, m.threshold, (v) => store.update(m.id, { threshold: v }, { silent: true }));
    const sel = modeSelect(m, store);
    const modeRow = document.createElement('label');
    modeRow.className = 'row';
    modeRow.append('Show', sel);

    const adv = document.createElement('details');
    adv.innerHTML = '<summary>Advanced</summary>';
    const advBody = document.createElement('div');
    advBody.append(...advancedSliders(m, store));
    adv.append(advBody);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const btn = (label, fn, cls = '') => {
      const b = Object.assign(document.createElement('button'), { textContent: label, className: cls });
      b.onclick = fn;
      return b;
    };
    actions.append(
      btn(rec ? 'Re-record' : 'Record pose', () => this.recordInList(m, true)),
      btn('+ Sample', () => this.recordInList(m, false)),
      btn('Setup', () => this.openWizard(m.id)),
      btn('Delete', () => { if (confirm(`Delete “${m.name}”?`)) store.remove(m.id); }, 'danger'),
    );
    actions.children[1].disabled = !m.samples.length || rec >= MAX_RECORDED;
    actions.children[1].title = `Add another recorded sample (max ${MAX_RECORDED})`;

    el.append(top, thr, modeRow, adv, actions);
    return { el };
  }

  async recordInList(meme, replace) {
    const f = await this.app.record(`Pose for “${meme.name}”`);
    if (f) {
      this.store.addRecorded(meme.id, f, { replace });
      toast('Pose recorded.');
    }
  }

  renderConflicts() {
    const box = $('conflicts');
    box.replaceChildren();
    for (const c of findConflicts(this.store.memes)) {
      const d = document.createElement('div');
      d.className = 'conflict';
      d.textContent = `“${c.a.name}” and “${c.b.name}” look too similar and may trigger each other. Re-record one of them with a more distinct pose.`;
      box.append(d);
    }
  }

  // --- per-frame updates -------------------------------------------------------------
  frame({ live, state, hasPerson, raw }) {
    const app = this.app;
    const chip = $('statusChip');
    if (!app.cameraReady) { /* chip set by app */ }
    else if (!hasPerson) { chip.textContent = 'No person detected'; chip.className = 'chip warn'; }
    else {
      const parts = [];
      if (raw.hands.length) parts.push(`${raw.hands.length} hand${raw.hands.length > 1 ? 's' : ''}`);
      if (raw.face) parts.push('face');
      if (raw.pose) parts.push('body');
      chip.textContent = parts.join(' · ') || 'Person detected';
      chip.className = 'chip ok';
    }
    $('fpsChip').textContent = app.fps ? `${Math.round(app.fps)} fps` : '';

    // display panel
    const active = this.store.get(state.activeId);
    const img = $('displayImg');
    const panelMeme = active && active.mode === 'panel' ? active : null;
    if (panelMeme) { if (img.getAttribute('src') !== panelMeme.image) img.src = panelMeme.image; }
    img.classList.toggle('show', !!panelMeme);
    $('displayEmpty').classList.toggle('hide', !!active);
    $('displayEmpty').textContent = 'Strike a pose';
    $('displayCaption').textContent = active ? (panelMeme ? active.name : `${active.name} (shown on camera)`) : '';
    for (const [id, c] of this.cards) c.el.classList.toggle('active', id === state.activeId);

    if (!$('testPanel').hidden) this.renderTest(state, live);
    if (this.wizard) this.frameWizard(live);
  }

  renderTest(state, live) {
    const best = state.best;
    $('testBest').textContent = !live ? 'No person detected'
      : best ? `${best.meme.name}  ·  distance ${best.distance.toFixed(2)} / ${best.meme.threshold.toFixed(2)}${state.valid ? '  ✓ match' : ''}`
        : 'No memes with samples yet';
    const rows = $('testRows');
    const max = 2;
    if (rows.children.length !== state.ranked.length) {
      rows.replaceChildren(...state.ranked.map(() => {
        const r = document.createElement('div');
        r.className = 'test-row';
        r.innerHTML = '<span></span><div class="bar"><i></i><b></b></div><span></span>';
        return r;
      }));
    }
    state.ranked.forEach(({ meme, distance }, i) => {
      const r = rows.children[i];
      r.children[0].textContent = meme.name;
      const fill = r.querySelector('i');
      fill.style.width = `${Math.min(1, distance / max) * 100}%`;
      fill.className = distance < meme.threshold ? 'ok' : '';
      r.querySelector('b').style.left = `${Math.min(1, meme.threshold / max) * 100}%`;
      r.children[2].textContent = isFinite(distance) ? distance.toFixed(2) : '–';
    });
  }

  // --- setup wizard ------------------------------------------------------------------
  openWizard(onlyId = null) {
    const queue = onlyId
      ? [onlyId]
      : this.store.memes.filter((m) => !m.confirmed).map((m) => m.id);
    if (!queue.length) { toast('All memes are set up. Use “Setup” on a meme to redo it.'); return; }
    this.wizard = { queue, index: 0, phase: 'try', total: queue.length, hold: 0, busy: false };
    $('wizard').hidden = false;
    this.showWizardMeme();
  }

  closeWizard() {
    this.wizard = null;
    $('wizard').hidden = true;
    $('wizardRecord').hidden = true;
    this.app.cancelRecording();
    this.renderList();
  }

  get wizMeme() { return this.wizard && this.store.get(this.wizard.queue[this.wizard.index]); }

  showWizardMeme() {
    const w = this.wizard, m = this.wizMeme;
    if (!m) { this.finishWizard(); return; }
    w.phase = 'try'; w.hold = 0; w.busy = false;
    $('wizardStep').textContent = `Meme ${w.index + 1} of ${w.total}: ${m.name}`;
    $('wizardImg').src = m.image;
    const mode = $('wizardMode');
    mode.replaceChildren();
    for (const [v, l] of Object.entries(DISPLAY_MODES)) mode.add(new Option(l, v, false, v === m.mode));
    mode.onchange = () => this.store.update(m.id, { mode: mode.value }, { silent: true });
    $('wizardAdvanced').replaceChildren(...advancedSliders(m, this.store));
    $('wizardMeterMark').style.left = `${Math.min(1, m.threshold / 2) * 100}%`;
    this.setWizardStatus();
  }

  setWizardStatus() {
    const w = this.wizard, m = this.wizMeme;
    const auto = m.samples.some((s) => s.kind === 'auto') && !m.samples.some((s) => s.kind === 'recorded');
    const recorded = m.samples.some((s) => s.kind === 'recorded');
    let msg;
    if (w.phase === 'confirm') msg = 'Now do the pose again to confirm.';
    else if (auto) msg = 'Auto-detected pose. Try it: copy this pose and see if it triggers.';
    else if (recorded) msg = 'Recorded. Try it: does the pose trigger?';
    else msg = 'Couldn’t read a pose from this image. Strike the pose and press Record.';
    $('wizardStatus').textContent = msg;
    $('wizWorks').disabled = !m.samples.length || w.phase === 'confirm';
    $('wizRecord').textContent = recorded || auto ? 'Re-record my pose ' : 'Record my pose ';
    $('wizRecord').insertAdjacentHTML('beforeend', '<kbd>Space</kbd>');
  }

  frameWizard(live) {
    const w = this.wizard, m = this.wizMeme;
    if (!m) return;
    this.app.drawMirror($('wizardCam'));
    const d = memeDistance(m, live);
    const ok = isFinite(d) && d < m.threshold;
    const fill = $('wizardMeterFill');
    fill.style.width = `${isFinite(d) ? Math.max(2, (1 - Math.min(d, 2) / 2) * 100) : 0}%`;
    // The meter fills as the pose gets closer; the mark shows where it triggers.
    $('wizardMeterMark').style.left = `${(1 - Math.min(m.threshold, 2) / 2) * 100}%`;
    fill.classList.toggle('ok', ok);
    const label = $('wizardMatch');
    label.classList.toggle('ok', ok);
    label.textContent = !live ? 'No person detected'
      : !m.samples.length ? ''
        : ok ? `Match!  (distance ${d.toFixed(2)})` : `Not matching yet  (distance ${d.toFixed(2)})`;

    // After recording, auto-advance once the pose is held for the debounce time.
    if (w.phase === 'confirm' && !w.busy) {
      w.hold = ok ? w.hold + 1 : 0;
      if (w.hold === 1) w.holdSince = performance.now();
      if (ok && performance.now() - w.holdSince > 300) this.confirmCurrent('Confirmed.');
    }
  }

  confirmCurrent(msg) {
    const w = this.wizard, m = this.wizMeme;
    this.store.update(m.id, { confirmed: true }, { silent: true });
    w.busy = true;
    $('wizardStatus').textContent = `${msg} ✓`;
    setTimeout(() => { if (this.wizard === w) this.advance(); }, 500);
  }

  advance() {
    const w = this.wizard;
    w.index++;
    this.showWizardMeme();
  }

  wizardWorks() {
    const w = this.wizard, m = this.wizMeme;
    if (!w || w.busy || !m) return;
    if (!m.samples.length) { toast('Record a pose first.'); return; }
    this.confirmCurrent('Saved');
  }

  wizardSkip() {
    const w = this.wizard;
    if (!w || w.busy) return;
    this.advance();
  }

  async wizardRecord() {
    const w = this.wizard, m = this.wizMeme;
    if (!w || w.busy || !m) return;
    w.busy = true;
    const f = await this.app.record(m.name, { wizard: true });
    if (this.wizard !== w) return;
    w.busy = false;
    if (f) {
      this.store.addRecorded(m.id, f, { replace: true });
      this.store.update(m.id, { confirmed: false }, { silent: true });
      w.phase = 'confirm'; w.hold = 0;
      this.setWizardStatus();
    }
  }

  finishWizard() {
    const left = this.store.memes.filter((m) => !m.confirmed).length;
    this.closeWizard();
    const conflicts = findConflicts(this.store.memes).length;
    toast(conflicts ? 'Setup done, but some memes look too similar (see warnings below).'
      : left ? `Setup done. ${left} meme(s) still unconfirmed.` : 'All set. Strike a pose!', !!conflicts);
  }
}

// --- helpers ----------------------------------------------------------------------------
/** Read an image file and downscale it so it fits comfortably in localStorage. */
export async function fileToDataUrl(file, max = 800) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), {
    width: Math.round(bmp.width * s), height: Math.round(bmp.height * s),
  });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const webp = c.toDataURL('image/webp', 0.88);
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.88);
}
