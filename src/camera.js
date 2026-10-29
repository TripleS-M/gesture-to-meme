export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((res) => { video.onloadedmetadata = res; });
  await video.play();
  return stream;
}

export function describeCameraError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in your browser (lock icon in the address bar), then retry.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Plug one in and retry.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app. Close it and retry.';
    case 'NotSupportedError':
      return 'This browser cannot access the camera here. Use localhost or https in a recent Chrome, Edge or Firefox.';
    default:
      return `Could not start the camera (${e?.message || e}).`;
  }
}
