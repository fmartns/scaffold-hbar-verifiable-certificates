/**
 * Reference credential documents of three different credential types (docs/credential-schema.md §Examples). They are
 * deterministic test vectors: fixed salts, fixed dates, fictitious subjects. Never reuse these salts in real issuance.
 */
import type { CredentialDocument } from "./schema";

/** 2026-09-12T00:00:00Z */
const SEPT_12_2026 = 1_789_171_200;

export const EVENT_ATTENDANCE: CredentialDocument = {
  version: 1,
  issuer: "hedera-hackathon",
  schema: "event-attendance.v1(string eventName,uint64 eventDate,string role)",
  reference: "HH-2026-ATT-000123",
  subject: {
    idType: "email",
    idValue: "alice@example.com",
    salt: "0x1111111111111111111111111111111111111111111111111111111111111111",
  },
  issuedAt: SEPT_12_2026,
  expiresAt: 0,
  claims: { eventName: "Hedera Hackathon São Paulo 2026", eventDate: SEPT_12_2026, role: "participant" },
};

export const COURSE_COMPLETION: CredentialDocument = {
  version: 1,
  issuer: "acme-university",
  schema: "course-completion.v1(string courseCode,string courseName,uint64 completedOn,uint64 hours,string grade)",
  reference: "ENR-2026-0042",
  subject: {
    idType: "student-id",
    idValue: "2026-000777",
    salt: "0x2222222222222222222222222222222222222222222222222222222222222222",
  },
  issuedAt: 1_790_000_000,
  expiresAt: 0,
  claims: {
    courseCode: "CS-301",
    courseName: "Distributed Ledgers",
    completedOn: 1_789_900_000,
    hours: 60,
    grade: "A",
  },
};

export const PROFESSIONAL_CERTIFICATION: CredentialDocument = {
  version: 1,
  issuer: "cloud-cert.org",
  schema: "professional-certification.v1(string certification,string level,uint64 examPassedOn,bytes32 examResultHash)",
  reference: "CC-ARCH-2026-9F3K",
  subject: {
    idType: "cpf",
    idValue: "00000000191",
    salt: "0x3333333333333333333333333333333333333333333333333333333333333333",
  },
  issuedAt: 1_790_100_000,
  // Valid for two years.
  expiresAt: 1_853_172_000,
  claims: {
    certification: "Cloud Solutions Architect",
    level: "professional",
    examPassedOn: 1_790_000_000,
    examResultHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
  },
};

export const CREDENTIAL_EXAMPLES = { EVENT_ATTENDANCE, COURSE_COMPLETION, PROFESSIONAL_CERTIFICATION };
