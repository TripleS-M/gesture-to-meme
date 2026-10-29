# Meme Mirror

Strike a pose in front of your webcam and the matching meme appears: above your head, over your face, or fullscreen.

**Everything runs locally.** Camera frames are never uploaded anywhere. There are no accounts, no cloud AI and no paid APIs. Recognition is MediaPipe landmarks plus a nearest-neighbour matcher, all in your browser.

## Quick start

```bash
npm install
npm run dev
```

(On Windows, if PowerShell says "running scripts is disabled", use `npm.cmd run dev` or run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once.)

(Run them as two separate commands. Windows PowerShell 5.1 doesn't support `&&`; use `;` if you want them on one line.)

`npm run dev` first runs `npm run setup`, which copies the MediaPipe WASM into `public/wasm/` and downloads the four `.task` models into `public/models/` (about 25 MB, internet needed **only that first time**). After that the app works fully offline. Then open http://localhost:5173 and allow camera access.

If the download failed, run `npm run setup` again, or put the model files in `public/models/` by hand.

## Adding memes (fast path)

1. Drag many images onto the page, or click **Add memes**. Each is analysed immediately with the same landmark code used for live video, and its pose is saved automatically (badge: **auto**).
2. The **Setup wizard** opens and walks through each meme: copy the pose and see the live match meter turn green, then press **Works, next** (Enter), **Record my pose** (Space, 3-2-1 countdown, then do the pose again to confirm) or **Skip** (S).
3. Alternatively drop image files into `public/memes/` and restart (`npm run scan` regenerates `public/memes-manifest.json`). New files are auto-imported on the next load.

Badges: **auto** = pose read from the image, **recorded** = from your camera, **needs recording** = no usable hand or expression found in the image (cartoons, animals, crops). Record those yourself.

Auto poses from images are matched with looser limits and with body pose weighted low, since the person in a meme has different proportions and camera angle from you. If one matches poorly, **Re-record**. Use **+ Sample** to add more recordings (up to 5) for robustness.

## Display modes

Per meme: **Above head** (default), **On face**, **Fullscreen**. The **Advanced** section has X/Y offset, scale and opacity sliders. Overlays follow your head with smoothing and match head roll, fading in and out in ~150 ms. Memes stay up for 1.5 s after you drop the pose.

## Tuning

- **Test mode** and the **Landmarks** overlay (only visible in `npm run dev`, never on the published site) shows the distance to every meme live, with each threshold marked. Lower the threshold if a meme fires accidentally; raise it if it does not fire.
- A meme triggers only when it is under its threshold, wins for 300 ms in a row, and beats the runner-up by a margin.
- After setup, memes whose poses match each other get a warning. Re-record one with a more distinct pose.
- If FPS falls below 20 the face and pose models automatically run every 2nd to 4th frame.

## Data

Memes and poses are saved in your browser's `localStorage` automatically. Uploaded images are downscaled and stored as data URLs. **Export** / **Import** move everything as one JSON file (also a good backup, since storage is limited to a few MB).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | setup (if needed), scan `public/memes/`, start Vite |
| `npm run setup` | copy WASM and download models |
| `npm run scan` | regenerate `public/memes-manifest.json` |
| `npm test` | unit tests (feature invariance, matcher debounce/margin) |
| `npm run build` | production build to `dist/` |

## How it works

- `src/features.js`: landmarks to feature vectors. Hands are wrist-relative, hand-size-normalised and left-mirrored-to-right; face is 14 blendshapes; pose is 7 upper-body points centred and scaled by shoulder width; relations are hand-to-face distances (mouth, chin, eye, cheek, nose, forehead) in face heights.
- `src/matcher.js`: weighted distance per feature group, debounce, hold and margin.
- `src/landmarkers.js`: MediaPipe Hand/Face/Pose landmarkers (GPU delegate with CPU fallback), VIDEO mode for the camera and IMAGE mode for meme import.
- The GestureRecognizer model is downloaded but not used; the landmark features cover the same ground.

## Notes

- Needs a recent Chrome, Edge or Firefox, and `localhost` or https for camera access.
- Neutral-face-only references are rejected for auto-import (they would match your resting face constantly); those memes show **needs recording**.
