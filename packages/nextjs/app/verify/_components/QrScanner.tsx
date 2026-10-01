"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import styles from "../verify.module.css";

export type ScannerStatus = "idle" | "starting" | "scanning" | "unsupported" | "denied" | "unavailable";

/**
 * Reads a credentialId (or a scanned `/verify/<credentialId>` URL) from the device camera, entirely on-device: no
 * frame or decoded value ever leaves the browser. Decoding is `jsqr`, a small, dependency-free QR reader that reads
 * raw pixel data from a `<canvas>` — there is no existing camera-scanning library in this codebase, and this is the
 * only one added for it. Always paired with the manual id field in {@link VerifyEntry}: a camera, HTTPS context or
 * permission may be unavailable, and that must never block verification.
 */
export function QrScanner({ onScanned }: { onScanned: (value: string) => void }) {
  const [status, setStatus] = useState<ScannerStatus>("idle");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const scannedRef = useRef(false);

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  const tick = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      frameRef.current = requestAnimationFrame(tick);
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      frameRef.current = requestAnimationFrame(tick);
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(frame.data, frame.width, frame.height);
    if (result && !scannedRef.current) {
      scannedRef.current = true;
      stop();
      onScanned(result.data);
      return;
    }
    frameRef.current = requestAnimationFrame(tick);
  }, [onScanned, stop]);

  const start = useCallback(async () => {
    scannedRef.current = false;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      return;
    }
    setStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus("scanning");
      frameRef.current = requestAnimationFrame(tick);
    } catch (error) {
      stop();
      setStatus(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unavailable");
    }
  }, [stop, tick]);

  useEffect(() => stop, [stop]);

  return (
    <div className={styles.scanner}>
      {status === "idle" && (
        <button type="button" className={styles.button} onClick={() => void start()}>
          Scan QR code
        </button>
      )}
      {status === "starting" && <p className={styles.muted}>Starting the camera…</p>}
      {status === "unsupported" && (
        <p className={styles.muted}>This browser cannot access the camera here; enter the credential id instead.</p>
      )}
      {status === "denied" && (
        <p className={styles.muted}>Camera access was denied; enter the credential id instead.</p>
      )}
      {status === "unavailable" && (
        <p className={styles.muted}>The camera could not be started; enter the credential id instead.</p>
      )}
      <video
        ref={videoRef}
        className={styles.video}
        hidden={status !== "scanning"}
        muted
        playsInline
        aria-label="Camera preview for scanning a credential QR code"
      />
      <canvas ref={canvasRef} hidden />
      {status === "scanning" && (
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            stop();
            setStatus("idle");
          }}
        >
          Stop scanning
        </button>
      )}
    </div>
  );
}
