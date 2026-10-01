import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Verifiable Settlement",
  description: "Event-driven settlement on Hedera: oracle, HCS, SettlementRouter, HTS and Mirror Node.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <strong>Verifiable Settlement</strong>
          <Link href="/">Home</Link>
          <Link href="/dashboard">Environment</Link>
          <Link href="/issuer">Issuer console</Link>
        </header>
        {children}
      </body>
    </html>
  );
}
