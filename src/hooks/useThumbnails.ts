import { useEffect, useRef, useState } from "react";

const THUMB_W = 160;
const THUMB_H = 90;
const THUMB_INTERVAL = 2; // seconds between thumbnails

/**
 * Extracts video frame thumbnails at regular intervals.
 * Returns a Map<number, ImageBitmap> keyed by source timestamp (in seconds).
 */
export function useThumbnails(
  videoSrc: string | undefined,
  sourceDuration: number,
): Map<number, ImageBitmap> {
  const [thumbs, setThumbs] = useState<Map<number, ImageBitmap>>(new Map());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef(false);

  useEffect(() => {
    if (!videoSrc || sourceDuration <= 0) return;

    abortRef.current = false;
    const newThumbs = new Map<number, ImageBitmap>();

    // Create offscreen video + canvas for extraction
    const video = document.createElement("video");
    video.src = videoSrc;
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    videoRef.current = video;

    const canvas = document.createElement("canvas");
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    canvasRef.current = canvas;
    const ctx = canvas.getContext("2d")!;

    // Compute timestamps to extract (start at 0.1 to avoid seek-to-0 issues)
    const timestamps: number[] = [0];
    for (let t = THUMB_INTERVAL; t < sourceDuration; t += THUMB_INTERVAL) {
      timestamps.push(t);
    }

    let idx = 0;

    const captureFrame = () => {
      if (abortRef.current) return;
      ctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
      createImageBitmap(canvas).then((bmp) => {
        if (abortRef.current) return;
        newThumbs.set(timestamps[idx], bmp);
        if (newThumbs.size % 5 === 0) setThumbs(new Map(newThumbs));
        idx++;
        extractNext();
      });
    };

    const extractNext = () => {
      if (abortRef.current || idx >= timestamps.length) {
        setThumbs(new Map(newThumbs));
        return;
      }

      const t = timestamps[idx];
      // If already at this time (e.g. t=0), capture directly
      if (Math.abs(video.currentTime - t) < 0.05) {
        captureFrame();
      } else {
        video.currentTime = t;
      }
    };

    const onSeeked = () => {
      captureFrame();
    };

    video.addEventListener("seeked", onSeeked);

    // Wait for video to be loadable
    const onCanPlay = () => {
      // Small delay to ensure video decoder is ready
      setTimeout(() => extractNext(), 100);
    };

    if (video.readyState >= 3) {
      onCanPlay();
    } else {
      video.addEventListener("canplaythrough", onCanPlay, { once: true });
    }

    return () => {
      abortRef.current = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("canplay", onCanPlay);
      video.src = "";
      videoRef.current = null;
    };
  }, [videoSrc, sourceDuration]);

  return thumbs;
}
