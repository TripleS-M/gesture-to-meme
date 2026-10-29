// One-time setup: copies WASM from node_modules and downloads the .task models.
// Needs internet only the first time; afterwards the app runs fully offline.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const root = path.resolve(import.meta.dirname, '..');
const wasmSrc = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = path.join(root, 'public/wasm');
const modelDir = path.join(root, 'public/models');

const BASE = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = {
  'hand_landmarker.task': `${BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  'face_landmarker.task': `${BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  'pose_landmarker_lite.task': `${BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  'gesture_recognizer.task': `${BASE}/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`,
};

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

fs.mkdirSync(wasmDst, { recursive: true });
fs.mkdirSync(modelDir, { recursive: true });

if (fs.existsSync(wasmSrc)) {
  for (const f of fs.readdirSync(wasmSrc)) {
    const dst = path.join(wasmDst, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(wasmSrc, f), dst);
  }
} else {
  console.warn('[setup] tasks-vision WASM not found; run npm install first.');
}

let failed = false;
for (const [name, url] of Object.entries(MODELS)) {
  const dest = path.join(modelDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) continue;
  console.log(`[setup] downloading ${name} ...`);
  try { await download(url, dest); } catch (e) {
    failed = true;
    console.warn(`[setup] could not download ${name}: ${e.message}`);
  }
}
if (failed) console.warn('[setup] Some models are missing. Re-run "npm run setup" with internet access, or place the files in public/models/ manually.');
else console.log('[setup] models and WASM ready.');
