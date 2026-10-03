// Browser-side client of the certificate API. Types only from the SDK: nothing server-side reaches the bundle.
import type { Decision, DocumentCheck, IssuerRecord, RegisterEntry } from "@sh/sdk/certificates";

export type { Decision, DocumentCheck, RegisterEntry };

export interface ConsoleState {
  network: string;
  hashscanUrl: string;
  mirrorNodeUrl: string;
  issuerName: string;
  issuer: IssuerRecord | null;
  holders: string[];
  policy: { offering: string; prerequisite: string; minimumGrade: number };
  certificates: RegisterEntry[];
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      body?.error?.code ?? "HTTP",
      body?.error?.message ?? `Request failed (HTTP ${response.status}).`,
    );
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  state: () => call<ConsoleState>("/api/state"),
  initializeIssuer: () => call<IssuerRecord>("/api/issuer", { method: "POST" }),
  issue: (input: { holder: string; holderName: string; studentId: string; course: string; grade: number }) =>
    call<RegisterEntry>("/api/certificates", json(input)),
  revoke: (certificateId: string) =>
    call<RegisterEntry>(`/api/certificates/${encodeURIComponent(certificateId)}/revoke`, { method: "POST" }),
  enroll: (holder: string, asOf?: number) => call<Decision>("/api/enroll", json({ holder, asOf })),
  checkDocument: (holder: string, certificateId: string, file: File) => {
    const form = new FormData();
    form.set("holder", holder);
    form.set("certificateId", certificateId);
    form.set("file", file);
    return call<DocumentCheck>("/api/document-check", { method: "POST", body: form });
  },
  documentUrl: (certificateId: string) => `/api/certificates/${encodeURIComponent(certificateId)}/document`,
};
