import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Verifiable Certificates on Hedera",
  description:
    "Privacy-preserving, revocable course certificates: AnonCreds credentials on the Hedera Verifiable Data Registry, with a downloadable PDF stored on HCS-1.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <strong>Verifiable Certificates</strong>
          <Link href="/">Console</Link>
          <a href="https://hips.hedera.com/hip/hip-762" target="_blank" rel="noreferrer">
            HIP-762
          </a>
        </header>
        {children}
      </body>
    </html>
  );
}
