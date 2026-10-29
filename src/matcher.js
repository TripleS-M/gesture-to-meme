// Weighted nearest-neighbour matching with debounce, hold and runner-up margin.
import { hasDistinctiveFace } from './features.js';

const SCALE = { hands: 0.5, face: 0.3, pose: 0.6, rel: 0.7 }; // rms distance that counts as "1.0"
const MISSING = 2; // scaled distance when the reference has a group but the live frame doesn't
const EXTRA_HAND = 1; // scaled distance charged when hand counts differ
export const AUTO_LOOSEN = 1.3; // auto-extracted references get a looser effective threshold

// Auto references come from a different person/camera, so full-body pose counts for little.
export const WEIGHTS = {
  auto: { hands: 1, face: 0.8, rel: 1, pose: 0.25 },
  recorded: { hands: 1, face: 0.8, rel: 1, pose: 0.6 },
};

const rms = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
};

/** Scaled per-group distances between a reference and a live feature. Groups the reference lacks are omitted. */
export function groupDistances(ref, live) {
  const out = {};
  if (ref.hands.length) {
    const refHasRel = ref.hands.some((h) => h.rel);
    if (!live.hands.length) {
      out.hands = MISSING;
      if (refHasRel) out.rel = MISSING;
    } else {
      const pair = (a, b) => ({
        h: rms(a.vec, b.vec) / SCALE.hands,
        r: a.rel && b.rel ? rms(a.rel, b.rel) / SCALE.rel : null,
      });
      const cost = (p) => p.h + (p.r ?? 0);
      const [a, b] = [ref.hands, live.hands];
      let pairs;
      if (a.length === 2 && b.length === 2) {
        const straight = [pair(a[0], b[0]), pair(a[1], b[1])];
        const crossed = [pair(a[0], b[1]), pair(a[1], b[0])];
        const c = (ps) => cost(ps[0]) + cost(ps[1]);
        pairs = c(straight) <= c(crossed) ? straight : crossed;
      } else if (a.length === 1 && b.length === 1) {
        pairs = [pair(a[0], b[0])];
      } else {
        // Different hand counts: best single pairing plus a penalty for the unmatched hand.
        let best = null;
        for (const x of a) for (const y of b) {
          const p = pair(x, y);
          if (!best || cost(p) < cost(best)) best = p;
        }
        pairs = [best, { h: EXTRA_HAND, r: best.r === null ? null : EXTRA_HAND }];
      }
      out.hands = pairs.reduce((s, p) => s + p.h, 0) / pairs.length;
      if (refHasRel) {
        const rs = pairs.map((p) => p.r).filter((r) => r !== null);
        out.rel = rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : MISSING;
      }
    }
  }
  if (ref.face) out.face = live.face ? rms(ref.face, live.face) / SCALE.face : MISSING;
  if (ref.pose) out.pose = live.pose ? rms(ref.pose, live.pose) / SCALE.pose : MISSING;
  return out;
}

export function sampleWeights(sample) {
  const w = { ...WEIGHTS[sample.kind] };
  // A hand pose with an incidental neutral face shouldn't be dragged down by face noise.
  if (sample.feature.hands.length && !hasDistinctiveFace(sample.feature)) w.face = 0.3;
  return w;
}

/** Combined distance (lower is closer) and its per-group breakdown. */
export function compare(sample, live) {
  const groups = groupDistances(sample.feature, live);
  const w = sampleWeights(sample);
  let num = 0, den = 0;
  for (const g in groups) { num += w[g] * groups[g]; den += w[g]; }
  return { distance: den ? num / den : Infinity, groups };
}

const effective = (sample, d) => d / (sample.kind === 'auto' ? AUTO_LOOSEN : 1);

/** Distance from live features to a meme (nearest sample), normalised so `threshold` applies equally. */
export function memeDistance(meme, live) {
  let best = Infinity;
  if (!live) return best;
  for (const s of meme.samples) best = Math.min(best, effective(s, compare(s, live).distance));
  return best;
}

export class Matcher {
  constructor({ debounceMs = 300, holdMs = 1500, margin = 0.06 } = {}) {
    Object.assign(this, { debounceMs, holdMs, margin });
    this.reset();
  }

  reset() {
    this.candidateId = null;
    this.candidateSince = 0;
    this.activeId = null;
    this.lastSeen = 0;
  }

  update(memes, live, now) {
    const ranked = memes
      .filter((m) => m.samples.length)
      .map((m) => ({ meme: m, distance: memeDistance(m, live) }))
      .sort((a, b) => a.distance - b.distance);
    const [best, second] = ranked;
    const valid = !!best && best.distance < best.meme.threshold &&
      (!second || second.distance - best.distance >= this.margin);

    if (valid) {
      const id = best.meme.id;
      if (id !== this.candidateId) { this.candidateId = id; this.candidateSince = now; }
      if (now - this.candidateSince >= this.debounceMs || id === this.activeId) {
        this.activeId = id;
        this.lastSeen = now;
      }
    } else {
      this.candidateId = null;
    }
    if (this.activeId && now - this.lastSeen > this.holdMs) this.activeId = null;

    return { ranked, best, valid, candidateId: this.candidateId, activeId: this.activeId };
  }
}

/** Pairs of memes whose poses match each other within threshold. */
export function findConflicts(memes) {
  const out = [];
  for (let i = 0; i < memes.length; i++) {
    for (let j = i + 1; j < memes.length; j++) {
      const [a, b] = [memes[i], memes[j]];
      let d = Infinity;
      for (const sa of a.samples) for (const sb of b.samples) {
        d = Math.min(d, effective(sa, compare(sa, sb.feature).distance), effective(sb, compare(sb, sa.feature).distance));
      }
      if (d < Math.max(a.threshold, b.threshold)) out.push({ a, b, distance: d });
    }
  }
  return out;
}
