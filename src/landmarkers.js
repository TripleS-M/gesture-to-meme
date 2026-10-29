// Loads and runs the MediaPipe models from local files (public/models, public/wasm).
import { FilesetResolver, HandLandmarker, FaceLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;
const MODEL = (f) => `${BASE}models/${f}`;

// How often the heavier models run at each throttle level (1 = every frame).
const THROTTLE = [
  { face: 1, pose: 1 },
  { face: 2, pose: 3 },
  { face: 3, pose: 4 },
];

async function create(Cls, fileset, modelFile, runningMode, options) {
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Cls.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL(modelFile), delegate },
        runningMode,
        ...options,
      });
    } catch (e) {
      if (delegate === 'CPU') throw e;
      console.warn(`${modelFile}: GPU delegate failed, falling back to CPU`, e);
    }
  }
}

const toRaw = (hand, face, pose) => ({
  hands: hand
    ? hand.landmarks.map((landmarks, i) => ({ landmarks, label: hand.handedness[i]?.[0]?.categoryName || 'Right' }))
    : [],
  face: face?.faceLandmarks?.length
    ? {
        landmarks: face.faceLandmarks[0],
        blendshapes: Object.fromEntries((face.faceBlendshapes?.[0]?.categories || []).map((c) => [c.categoryName, c.score])),
      }
    : null,
  pose: pose?.landmarks?.length ? { landmarks: pose.landmarks[0] } : null,
});

export class Landmarkers {
  constructor() {
    this.video = {};
    this.image = null;
    this.level = 0;
    this.frame = 0;
    this.lastTs = 0;
    this.last = { hand: null, face: null, pose: null };
  }

  async init(onProgress = () => {}) {
    this.fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`);
    onProgress('Loading hand model…');
    this.video.hand = await create(HandLandmarker, this.fileset, 'hand_landmarker.task', 'VIDEO', { numHands: 2 });
    onProgress('Loading face model…');
    this.video.face = await create(FaceLandmarker, this.fileset, 'face_landmarker.task', 'VIDEO', {
      numFaces: 1, outputFaceBlendshapes: true,
    });
    onProgress('Loading pose model…');
    this.video.pose = await create(PoseLandmarker, this.fileset, 'pose_landmarker_lite.task', 'VIDEO', { numPoses: 1 });
  }

  setLevel(n) { this.level = Math.max(0, Math.min(THROTTLE.length - 1, n)); }

  /** Run on a video frame. Face and pose are throttled; their last result is reused in between. */
  detectVideo(video) {
    const ts = Math.max(this.lastTs + 1, Math.round(performance.now()));
    this.lastTs = ts;
    const t = THROTTLE[this.level];
    const n = this.frame++;
    this.last.hand = this.video.hand.detectForVideo(video, ts);
    if (n % t.face === 0) this.last.face = this.video.face.detectForVideo(video, ts);
    if (n % t.pose === 1 % t.pose) this.last.pose = this.video.pose.detectForVideo(video, ts);
    return toRaw(this.last.hand, this.last.face, this.last.pose);
  }

  /** Same models in IMAGE mode, created on first use. */
  async detectImage(img) {
    if (!this.image) {
      const f = this.fileset;
      this.image = {
        hand: await create(HandLandmarker, f, 'hand_landmarker.task', 'IMAGE', { numHands: 2, minHandDetectionConfidence: 0.4 }),
        face: await create(FaceLandmarker, f, 'face_landmarker.task', 'IMAGE', {
          numFaces: 1, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.4,
        }),
        pose: await create(PoseLandmarker, f, 'pose_landmarker_lite.task', 'IMAGE', { numPoses: 1 }),
      };
    }
    return toRaw(this.image.hand.detect(img), this.image.face.detect(img), this.image.pose.detect(img));
  }
}

export const CONNECTIONS = {
  hand: HandLandmarker.HAND_CONNECTIONS,
  pose: [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]]
    .map(([start, end]) => ({ start, end })),
  face: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL.concat(
    FaceLandmarker.FACE_LANDMARKS_LIPS,
    FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
    FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  ),
};
