"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import styles from "../issuer.module.css";

/** QR code of a value (the credential ID), rendered locally: the value is never sent to a third-party service. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 1, width: 192 })
      .then(url => !cancelled && setSrc(url))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) return <p className={styles.muted}>The QR code could not be generated; copy the ID instead.</p>;
  if (!src) return <div className={styles.qrPlaceholder} aria-label="Generating QR code" />;
  // eslint-disable-next-line @next/next/no-img-element -- a local data URL; next/image adds nothing here.
  return <img className={styles.qr} src={src} alt={label} width={192} height={192} />;
}
