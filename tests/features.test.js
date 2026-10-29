import { describe, it, expect } from 'vitest';
import {
  handVector, relationVector, poseVector, extractFeatures, averageFeatures, Smoother, isDistinctive,
  faceVector,
} from '../src/features.js';
import { Matcher, compare, memeDistance, findConflicts } from '../src/matcher.js';

// Deterministic pseudo-random landmarks.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const makeHand = (seed = 1) => {
  const r = rng(seed);
  return Array.from({ length: 21 }, () => ({ x: 0.4 + r() * 0.2, y: 0.4 + r() * 0.2, z: (r() - 0.5) * 0.05 }));
};
const makeFace = (seed = 2) => {
  const r = rng(seed);
  const lm = Array.from({ length: 468 }, () => ({ x: 0.3 + r() * 0.1, y: 0.2 + r() * 0.1, z: 0 }));
  lm[10] = { x: 0.35, y: 0.2, z: 0 };
  lm[152] = { x: 0.35, y: 0.4, z: 0 };
  return lm;
};
const transform = (lm, { s = 1, dx = 0, dy = 0, flip = false }) =>
  lm.map((p) => ({ x: (flip ? -p.x : p.x) * s + dx, y: p.y * s + dy, z: p.z * s }));

describe('handVector', () => {
  const hand = makeHand();
  it('is invariant to position', () => {
    const a = handVector(hand, 'Right');
    const b = handVector(transform(hand, { dx: 0.2, dy: -0.1 }), 'Right');
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
  });
  it('is invariant to scale', () => {
    const a = handVector(hand, 'Right');
    const b = handVector(transform(hand, { s: 0.5 }), 'Right');
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
  });
  it('maps a mirrored left hand onto the right hand', () => {
    const right = handVector(hand, 'Right');
    const left = handVector(transform(hand, { flip: true }), 'Left');
    right.forEach((v, i) => expect(left[i]).toBeCloseTo(v, 9));
  });
  it('has 60 dimensions', () => expect(handVector(hand, 'Right')).toHaveLength(60));
});

describe('relationVector', () => {
  const hand = makeHand(3), face = makeFace();
  it('is invariant to scale and translation of the whole scene', () => {
    const a = relationVector(hand, face);
    const t = { s: 0.6, dx: 0.1, dy: 0.05 };
    const b = relationVector(transform(hand, t), transform(face, t));
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
  });
  it('drops when the hand moves onto the mouth', () => {
    const far = relationVector(hand, face);
    const onMouth = hand.map((p) => ({ ...face[13], z: 0 }));
    const near = relationVector(onMouth, face);
    expect(near[0]).toBeLessThan(far[0]);
  });
});

describe('poseVector', () => {
  const pose = Array.from({ length: 33 }, (_, i) => ({ x: 0.3 + i * 0.01, y: 0.2 + i * 0.015, visibility: 1 }));
  it('is invariant to position and scale', () => {
    const a = poseVector(pose);
    const b = poseVector(transform(pose, { s: 0.7, dx: 0.1, dy: 0.1 }).map((p) => ({ ...p, visibility: 1 })));
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
  });
  it('returns null when shoulders are not visible', () => {
    expect(poseVector(pose.map((p) => ({ ...p, visibility: 0.1 })))).toBeNull();
  });
});

describe('extractFeatures', () => {
  const raw = (hands, extra = {}) => ({
    hands: hands.map((lm) => ({ landmarks: lm, label: 'Right' })),
    face: { landmarks: makeFace(), blendshapes: { jawOpen: 0.8 } },
    pose: null, ...extra,
  });
  it('orders hands by wrist x', () => {
    const left = transform(makeHand(5), { dx: -0.3 });
    const right = transform(makeHand(6), { dx: 0.3 });
    const f = extractFeatures(raw([right, left]));
    expect(f.hands[0].x).toBeLessThan(f.hands[1].x);
  });
  it('treats an open mouth as distinctive but a neutral face as not', () => {
    expect(isDistinctive({ hands: [], face: faceVector({ jawOpen: 0.9, mouthFunnel: 0.4 }), pose: null })).toBe(true);
    expect(isDistinctive({ hands: [], face: faceVector({}), pose: null })).toBe(false);
  });
});

describe('averaging', () => {
  const f = (v) => ({ hands: [], face: [v, v], pose: null });
  it('averages face features', () => {
    expect(averageFeatures([f(0), f(1)]).face).toEqual([0.5, 0.5]);
  });
  it('smoother averages over its window', () => {
    const s = new Smoother(2);
    s.push(f(0)); s.push(f(1));
    expect(s.push(f(1)).face[0]).toBeCloseTo(1);
  });
  it('smoother clears when the person leaves', () => {
    const s = new Smoother(3);
    s.push(f(1));
    expect(s.push({ hands: [], face: null, pose: null })).toBeNull();
    expect(s.push(f(0)).face[0]).toBe(0);
  });
});

describe('matcher', () => {
  const feat = (v) => ({ hands: [], face: Array(14).fill(v), pose: null });
  const meme = (id, v, threshold = 0.5) => ({
    id, threshold, samples: [{ kind: 'recorded', feature: feat(v) }],
  });
  const memes = [meme('a', 0), meme('b', 1)];

  it('has zero distance to an identical sample', () => {
    expect(compare(memes[0].samples[0], feat(0)).distance).toBe(0);
  });
  it('debounces before activating', () => {
    const m = new Matcher({ debounceMs: 300 });
    expect(m.update(memes, feat(0), 0).activeId).toBeNull();
    expect(m.update(memes, feat(0), 200).activeId).toBeNull();
    expect(m.update(memes, feat(0), 320).activeId).toBe('a');
  });
  it('restarts the debounce when the winner changes', () => {
    const m = new Matcher({ debounceMs: 300 });
    m.update(memes, feat(0), 0);
    m.update(memes, feat(1), 250);
    expect(m.update(memes, feat(1), 400).activeId).toBeNull();
    expect(m.update(memes, feat(1), 560).activeId).toBe('b');
  });
  it('holds the meme after the pose is lost, then releases', () => {
    const m = new Matcher({ debounceMs: 0, holdMs: 1500 });
    m.update(memes, feat(0), 0);
    expect(m.update(memes, null, 1000).activeId).toBe('a');
    expect(m.update(memes, null, 1600).activeId).toBeNull();
  });
  it('rejects matches above the threshold', () => {
    const m = new Matcher({ debounceMs: 0 });
    expect(m.update(memes, feat(0.5), 0).valid).toBe(false);
  });
  it('rejects ambiguous matches that do not beat the runner-up by the margin', () => {
    const twins = [meme('a', 0, 5), meme('b', 0.001, 5)];
    const m = new Matcher({ debounceMs: 0, margin: 0.06 });
    expect(m.update(twins, feat(0), 0).valid).toBe(false);
  });
  it('loosens auto references', () => {
    const auto = { id: 'x', threshold: 0.5, samples: [{ kind: 'auto', feature: feat(0) }] };
    const rec = { id: 'y', threshold: 0.5, samples: [{ kind: 'recorded', feature: feat(0) }] };
    expect(memeDistance(auto, feat(0.1))).toBeLessThan(memeDistance(rec, feat(0.1)));
  });
  it('flags memes that match each other', () => {
    expect(findConflicts([meme('a', 0), meme('b', 0.01)])).toHaveLength(1);
    expect(findConflicts([meme('a', 0), meme('b', 1)])).toHaveLength(0);
  });
});
