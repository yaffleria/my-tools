import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Camera helpers for a mobile web page (or a page inside a WebView).
 *
 * Two ways to take a photo on mobile web:
 * - `<input type="file" accept="image/*" capture="environment">` opens the OS camera app.
 *   No code here is needed for that. It is the safest fallback.
 * - `getUserMedia` streams the camera into a `<video>` so you can draw a guide on top
 *   (for example an ID card frame). That is what `useCameraStream` does.
 *
 * `getUserMedia` only works in a secure context (HTTPS or localhost).
 */

export type CameraStatus = 'idle' | 'starting' | 'live' | 'denied' | 'unsupported' | 'error';

export interface UseCameraStreamOptions {
  /** `environment` = back camera, `user` = front camera. Default `environment`. */
  facingMode?: 'environment' | 'user';
  /** Ideal stream width in pixels. The browser may pick something else. Default `1920`. */
  idealWidth?: number;
}

export interface UseCameraStreamResult {
  /** Attach to a `<video autoPlay playsInline muted>` element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  status: CameraStatus;
  /** The last error from `getUserMedia`, if any. */
  error: unknown;
  /** Ask for permission and start streaming. Safe to call again after `stop`. */
  start: () => Promise<void>;
  /** Stop every track. The camera light turns off. Also runs on unmount. */
  stop: () => void;
}

export function isCameraSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export function useCameraStream(options: UseCameraStreamOptions = {}): UseCameraStreamResult {
  const { facingMode = 'environment', idealWidth = 1920 } = options;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The stream is not rendered, so it lives in a ref instead of state.
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus((current) => (current === 'live' || current === 'starting' ? 'idle' : current));
  }, []);

  const start = useCallback(async () => {
    if (!isCameraSupported()) {
      setStatus('unsupported');
      return;
    }
    stop();
    setStatus('starting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: idealWidth } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setStatus('live');
    } catch (caught) {
      setError(caught);
      const name = caught instanceof DOMException ? caught.name : '';
      setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
    }
  }, [facingMode, idealWidth, stop]);

  // Turn the camera off when the component goes away.
  useEffect(() => stop, [stop]);

  return { videoRef, status, error, start, stop };
}

export interface CaptureOptions {
  /** Scale down so the width is at most this many pixels. Default `1280`. */
  maxWidth?: number;
  /** Default `image/jpeg`. */
  type?: string;
  /** 0–1, used for JPEG and WebP. Default `0.8`. */
  quality?: number;
}

/** Draw the current video frame on a canvas and return it as a compressed Blob. */
export function captureFrame(video: HTMLVideoElement, options: CaptureOptions = {}): Promise<Blob> {
  const { maxWidth = 1280, type = 'image/jpeg', quality = 0.8 } = options;
  if (!video.videoWidth || !video.videoHeight) {
    return Promise.reject(new Error('Video has no frame yet. Wait until the stream is live.'));
  }
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('Canvas 2D context is not available.'));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas could not encode the image.'))),
      type,
      quality,
    );
  });
}
