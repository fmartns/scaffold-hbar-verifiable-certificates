// Server-only: opens Askar wallets and holds the operator key. Never import this from a client component.
export { CertificateError } from "./errors";
export type { CertificateErrorCode } from "./errors";
export { CERTIFICATE_ENV, loadCertificatesConfig } from "./config";
export type { CertificatesConfig } from "./config";
export { CERTIFICATE_SCHEMA, ISSUER_NAME } from "./issuer";
export type { IssueCertificateInput } from "./issuer";
export { ENROLLMENT_POLICY } from "./platform";
export type { Decision, DocumentCheck } from "./platform";
export type { Verification } from "./presentation";
export { LocalTailsFileService } from "./agents";
export { CertificateService, HOLDERS, isHolder, toRegisterEntry } from "./service";
export type { HolderLabel, PublicCertificate, RegisterEntry } from "./service";
export type { CertificateRecord, IssuerRecord } from "./store";
