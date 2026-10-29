// Landmarks -> normalised feature vectors. Used identically for live video and meme images.
//
// Raw input shape (produced by landmarkers.js):
//   { hands: [{ landmarks, label }], face: { landmarks, blendshapes: {name: score} } | null, pose: { landmarks } | null }
// `aspect` is width / height of the source, so x and y share the same unit.

export const BLENDSHAPES = [
  'mouthSmileLeft', 'mouthSmileRight', 'jawOpen', 'mouthFunnel', 'mouthPucker',
  'browInnerUp', 'browDownLeft', 'browDownRight', 'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeWideLeft', 'eyeWideRight', 'mouthFrownLeft', 'mouthFrownRight',
];
// Blendshapes that describe the expression (blinks excluded: they happen constantly).
const EXPRESSIVE = BLENDSHAPES.filter((n) => !n.startsWith('eyeBlink'));

const POSE_IDX = [0, 11, 12, 13, 14, 15, 16]; // nose, shoulders, elbows, wrists
const HAND_POINTS = [9, 8, 4, 12]; // palm, index tip, thumb tip, middle tip
const REL_CAP = 3;

export const HAND_DIM = 60;
export const REL_DIM = HAND_POINTS.length * 6;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const px = (p, aspect) => [p.x * aspect, p.y, (p.z || 0) * aspect];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** Wrist-relative, hand-size-normalised vector. Left hands are mirrored onto right hands. */
export function handVector(lm, label, aspect = 1) {
  const pts = lm.map((p) => px(p, aspect));
  const scale = dist(pts[0], pts[9]) || 1e-6;
  const sign = label === 'Left' ? -1 : 1;
  const v = [];
  for (let i = 1; i < 21; i++) {
    v.push(
      (sign * (pts[i][0] - pts[0][0])) / scale,
      (pts[i][1] - pts[0][1]) / scale,
      (pts[i][2] - pts[0][2]) / scale,
    );
  }
  return v;
}

/** Face anchor points and face height (forehead to chin), in pixel-like units. */
export function faceTargets(faceLm, aspect = 1) {
  const f = faceLm.map((p) => px(p, aspect));
  const height = dist(f[10], f[152]) || 1e-6;
  return {
    height,
    pts: {
      mouth: f[13], chin: f[152], nose: f[1], forehead: f[10],
      eyes: [mid(f[33], f[133]), mid(f[362], f[263])],
      cheeks: [f[234], f[454]],
    },
  };
}

/** Hand-to-face distances in face heights. Symmetric targets are folded so left/right doesn't matter. */
export function relationVector(handLm, faceLm, aspect = 1) {
  const { height, pts } = faceTargets(faceLm, aspect);
  const h = handLm.map((p) => px(p, aspect));
  const out = [];
  for (const i of HAND_POINTS) {
    const p = h[i];
    const d = (t) => Math.min(REL_CAP, dist(p, t) / height);
    out.push(
      d(pts.mouth), d(pts.chin), d(pts.nose), d(pts.forehead),
      Math.min(d(pts.eyes[0]), d(pts.eyes[1])),
      Math.min(d(pts.cheeks[0]), d(pts.cheeks[1])),
    );
  }
  return out;
}

export function faceVector(blendshapes) {
  return BLENDSHAPES.map((n) => clamp(blendshapes[n] || 0, 0, 1));
}

/** Upper-body pose, centred on the shoulder midpoint and divided by shoulder width. */
export function poseVector(lm, aspect = 1) {
  const l = lm[11], r = lm[12];
  if (!l || !r || (l.visibility ?? 1) < 0.5 || (r.visibility ?? 1) < 0.5) return null;
  const a = px(l, aspect), b = px(r, aspect);
  const c = mid(a, b);
  const sw = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1e-6;
  const v = [];
  for (const i of POSE_IDX) {
    const p = px(lm[i], aspect);
    v.push(clamp((p[0] - c[0]) / sw, -4, 4), clamp((p[1] - c[1]) / sw, -4, 4));
  }
  return v;
}

export function extractFeatures(raw, aspect = 1) {
  const faceLm = raw.face?.landmarks;
  const hands = (raw.hands || []).map((h) => ({
    vec: handVector(h.landmarks, h.label, aspect),
    rel: faceLm ? relationVector(h.landmarks, faceLm, aspect) : null,
    x: h.landmarks[0].x,
  }));
  hands.sort((a, b) => a.x - b.x);
  return {
    hands,
    face: raw.face ? faceVector(raw.face.blendshapes || {}) : null,
    pose: raw.pose ? poseVector(raw.pose.landmarks, aspect) : null,
  };
}

export const hasPerson = (f) => !!f && (f.hands.length > 0 || !!f.face || !!f.pose);

export function expressionEnergy(face) {
  if (!face) return 0;
  return EXPRESSIVE.reduce((s, n) => s + face[BLENDSHAPES.indexOf(n)], 0);
}

/** Is the face expression strong enough to identify a meme on its own? */
export const hasDistinctiveFace = (f) => expressionEnergy(f?.face) > 0.9;

/**
 * Can this feature vector identify a pose? A neutral face alone cannot, or it would
 * match the user's resting face all the time.
 */
export const isDistinctive = (f) => !!f && (f.hands.length > 0 || hasDistinctiveFace(f));

// --- averaging / smoothing ---------------------------------------------------------

const meanVec = (vs) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);

/** Average a list of features. Frames are grouped by hand count; the most common group wins. */
export function averageFeatures(list) {
  list = list.filter(hasPerson);
  if (!list.length) return null;
  const counts = new Map();
  for (const f of list) counts.set(f.hands.length, (counts.get(f.hands.length) || 0) + 1);
  const n = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const same = list.filter((f) => f.hands.length === n);
  const hands = [];
  for (let i = 0; i < n; i++) {
    const rels = same.map((f) => f.hands[i].rel).filter(Boolean);
    hands.push({
      vec: meanVec(same.map((f) => f.hands[i].vec)),
      rel: rels.length > same.length / 2 ? meanVec(rels) : null,
      x: same.reduce((s, f) => s + f.hands[i].x, 0) / same.length,
    });
  }
  const faces = list.map((f) => f.face).filter(Boolean);
  const poses = list.map((f) => f.pose).filter(Boolean);
  return {
    hands,
    face: faces.length > list.length / 2 ? meanVec(faces) : null,
    pose: poses.length > list.length / 2 ? meanVec(poses) : null,
  };
}

/** Short moving average over the last `size` frames. */
export class Smoother {
  constructor(size = 4) { this.size = size; this.buf = []; }
  reset() { this.buf = []; }
  push(f) {
    if (!hasPerson(f)) { this.buf = []; return null; }
    this.buf.push(f);
    if (this.buf.length > this.size) this.buf.shift();
    return averageFeatures(this.buf);
  }
}

/** Trim precision so stored samples stay small in localStorage. */
export function roundFeature(f) {
  const r = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);
  return {
    hands: f.hands.map((h) => ({ vec: r(h.vec), rel: h.rel && r(h.rel), x: Math.round(h.x * 1e4) / 1e4 })),
    face: f.face && r(f.face),
    pose: f.pose && r(f.pose),
  };
}
