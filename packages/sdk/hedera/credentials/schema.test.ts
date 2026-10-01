import { describe, expect, it } from "vitest";
import { AbiCoder, id, keccak256, toUtf8Bytes } from "ethers";
import { computeCredentialId, validateCredentialEvent } from "../hcs/credential-envelope";
import {
  CREDENTIAL_CONTENT_TAG,
  CredentialSchemaError,
  EXTERNAL_CREDENTIAL_ID_TAG,
  SUBJECT_COMMITMENT_TAG,
  computeClaimsHash,
  computeCredentialHash,
  computeExternalCredentialId,
  computeIssuerId,
  computeSchemaId,
  computeSubjectCommitment,
  deriveCredential,
  generateSubjectSalt,
  isCredentialExpired,
  parseSchemaDescriptor,
  schemaDescriptor,
  toCredentialEvent,
} from "./schema";
import type { CredentialDocument, CredentialModel } from "./schema";
import { COURSE_COMPLETION, CREDENTIAL_EXAMPLES, EVENT_ATTENDANCE, PROFESSIONAL_CERTIFICATION } from "./test-fixtures";

const coder = AbiCoder.defaultAbiCoder();

function derive(document: unknown): CredentialModel {
  const result = deriveCredential(document);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function issuesOf(document: unknown): string[] {
  const result = deriveCredential(document);
  return result.ok ? [] : result.issues.map(i => `${i.field}:${i.code}`);
}

const withDoc = (base: CredentialDocument, patch: Partial<CredentialDocument>): CredentialDocument => ({
  ...base,
  ...patch,
});

/**
 * Golden vectors. They pin the formulas of docs/credential-schema.md: if one changes, every credentialId and
 * credentialHash already issued changes with it, which is a breaking change of the credential model.
 */
const GOLDEN = {
  EVENT_ATTENDANCE: {
    issuer: "0x2f20a6b0c1ecb1b5c35d3d2974c0b0b8334fde45194c6deca2c465270afc5fe7",
    schemaId: "0x0735d5cda458c71fc5c4d88e26cbf8de746cca2018078b4c6eaaabb7000c666a",
    externalCredentialId: "0xffd448abf6c2d3bd5362e02661f9bb9903d5814d439fbb157aa53c42f79d91fe",
    credentialId: "0xe0b511e689238665db9e54d6f79f26c6eb258af2dd6b9b2b9cf45260d17fe878",
    subjectCommitment: "0xd5ba823fe238365794a0a79878fe6cb263dac3e28d62d1388a1fc65ac37b2dc9",
    credentialHash: "0xa7473093ffbd625a11998b846fad5a17bc9e14155e51a0842114d0ff59ed1bc9",
  },
  COURSE_COMPLETION: {
    issuer: "0x951742955e4dc83bd4aa94fba53af916b9a18b8072739c3a199834390ea30f5c",
    schemaId: "0xd23903e5fe94d3ee4a2cc30b31b5c511a6ab87320256fa6e14b0cc7075866393",
    externalCredentialId: "0x8f3c014161eb3bd79a69c31a467234c48b749a2d89184e218a8fc3d311226230",
    credentialId: "0x814f99eed64d91c74214ecf854591e7f22370cf075a05b98fc1087d618cb824c",
    subjectCommitment: "0xd3741e349499254c5de5a81b3ef1f17829eac716c6dced60a3ea1b8344803199",
    credentialHash: "0x954bf2574605db54cc1887aec26a4b1150da099adac9834a3c210cbca29a6a5f",
  },
  PROFESSIONAL_CERTIFICATION: {
    issuer: "0x7ea42e0b76be0b249b719fe0bf33249ff3dd9bf890d89e5125820dfa66f98df5",
    schemaId: "0x8ebe9bddaa5375d83586f0b4966724f57f0cfd5b2d703b640ca71704aebcaad8",
    externalCredentialId: "0x7cc0fd9de1c3c95a506470a5fc8d8b607e583a12bd06bc6704b3b5481df4cebe",
    credentialId: "0xd08444dbfe6c4efaf2c011cdcbf299f714bc5e82c3bc8f0387505c8d77f5969b",
    subjectCommitment: "0x89fd1abf654ecd0288677b08388a04b27e4536be7cfffb38c86f11f392cadc9f",
    credentialHash: "0x1ded73ec066014cdda01ffd3f72fdce16ff490572aa3bf4c63d4dc5583335fc1",
  },
};

describe("credential schema: constants", () => {
  it("pins the domain-separation tags", () => {
    expect(EXTERNAL_CREDENTIAL_ID_TAG).toBe(keccak256(toUtf8Bytes("hedera-verifiable-credentials.external-id.v1")));
    expect(SUBJECT_COMMITMENT_TAG).toBe(keccak256(toUtf8Bytes("hedera-verifiable-credentials.subject.v1")));
    expect(CREDENTIAL_CONTENT_TAG).toBe(keccak256(toUtf8Bytes("hedera-verifiable-credentials.content.v1")));
  });
});

describe("credential schema: examples of three credential types", () => {
  it.each(Object.entries(CREDENTIAL_EXAMPLES))("derives the pinned identifiers of %s", (name, document) => {
    const model = derive(document);
    const golden = GOLDEN[name as keyof typeof GOLDEN];
    expect({
      issuer: model.issuer,
      schemaId: model.schemaId,
      externalCredentialId: model.externalCredentialId,
      credentialId: model.credentialId,
      subjectCommitment: model.subjectCommitment,
      credentialHash: model.credentialHash,
    }).toEqual(golden);
  });

  it("gives every example a distinct schema, identity and content", () => {
    const models = Object.values(CREDENTIAL_EXAMPLES).map(derive);
    for (const key of ["schemaId", "credentialId", "credentialHash", "subjectCommitment"] as const) {
      expect(new Set(models.map(m => m[key])).size).toBe(models.length);
    }
  });

  it("produces a v1 wire event the registry structure checks accept", () => {
    for (const document of Object.values(CREDENTIAL_EXAMPLES)) {
      const model = derive(document);
      const event = toCredentialEvent(model, {
        signedAt: 1_790_200_000n,
        validUntil: 1_790_200_600n,
        submitter: "0x0000000000000000000000000000000000000000",
      });
      expect(validateCredentialEvent(event).ok).toBe(true);
      expect(computeCredentialId(event.issuer, event.externalCredentialId)).toBe(model.credentialId);
    }
  });
});

describe("credential schema: determinism (same input ⇒ same credentialId, always)", () => {
  it("is stable across repeated calls", () => {
    const first = derive(COURSE_COMPLETION);
    for (let i = 0; i < 50; i += 1) expect(derive(COURSE_COMPLETION)).toEqual(first);
  });

  it("is stable across a JSON round-trip and integer representation (number, string, bigint)", () => {
    const first = derive(PROFESSIONAL_CERTIFICATION);
    expect(derive(JSON.parse(JSON.stringify(PROFESSIONAL_CERTIFICATION)))).toEqual(first);
    expect(
      derive({
        ...PROFESSIONAL_CERTIFICATION,
        issuedAt: String(PROFESSIONAL_CERTIFICATION.issuedAt),
        expiresAt: BigInt(PROFESSIONAL_CERTIFICATION.expiresAt as number),
        claims: { ...PROFESSIONAL_CERTIFICATION.claims, examPassedOn: 1_790_000_000n },
      }),
    ).toEqual(first);
  });

  it("does not depend on the key order of the document or of its claims", () => {
    const reordered = Object.fromEntries(Object.entries(COURSE_COMPLETION).reverse());
    reordered.claims = Object.fromEntries(Object.entries(COURSE_COMPLETION.claims).reverse());
    expect(derive(reordered)).toEqual(derive(COURSE_COMPLETION));
  });

  it("does not depend on the case of hex inputs", () => {
    const lower = withDoc(PROFESSIONAL_CERTIFICATION, {
      subject: { ...PROFESSIONAL_CERTIFICATION.subject, salt: "0x" + "ab".repeat(32) },
      claims: { ...PROFESSIONAL_CERTIFICATION.claims, examResultHash: "0x" + "cd".repeat(32) },
    });
    const upper = withDoc(PROFESSIONAL_CERTIFICATION, {
      subject: { ...PROFESSIONAL_CERTIFICATION.subject, salt: "0x" + "AB".repeat(32) },
      claims: { ...PROFESSIONAL_CERTIFICATION.claims, examResultHash: "0x" + "CD".repeat(32) },
    });
    expect(derive(upper)).toEqual(derive(lower));
  });
});

describe("credential schema: identity rules", () => {
  it("credentialId depends only on issuer, schema and reference (C1, C3)", () => {
    const base = derive(EVENT_ATTENDANCE);
    const variants: CredentialDocument[] = [
      withDoc(EVENT_ATTENDANCE, { subject: { ...EVENT_ATTENDANCE.subject, salt: "0x" + "ab".repeat(32) } }),
      withDoc(EVENT_ATTENDANCE, { subject: { ...EVENT_ATTENDANCE.subject, idValue: "bob@example.com" } }),
      withDoc(EVENT_ATTENDANCE, { issuedAt: 1_789_171_201 }),
      withDoc(EVENT_ATTENDANCE, { expiresAt: 1_900_000_000 }),
      withDoc(EVENT_ATTENDANCE, { claims: { ...EVENT_ATTENDANCE.claims, role: "speaker" } }),
    ];
    for (const variant of variants) {
      const model = derive(variant);
      expect(model.credentialId).toBe(base.credentialId);
      expect(model.credentialHash).not.toBe(base.credentialHash);
    }
  });

  it("is stable across re-signing: the issuance window is not part of identity or content (C2)", () => {
    const model = derive(EVENT_ATTENDANCE);
    const a = toCredentialEvent(model, { signedAt: 1n, validUntil: 2n, submitter: "0x" + "0".repeat(40) });
    const b = toCredentialEvent(model, { signedAt: 99n, validUntil: 900n, submitter: "0x" + "1".repeat(40) });
    expect([a.issuer, a.externalCredentialId, a.credentialHash, a.subjectCommitment, a.schemaId]).toEqual([
      b.issuer,
      b.externalCredentialId,
      b.credentialHash,
      b.subjectCommitment,
      b.schemaId,
    ]);
  });

  it("separates issuers, schemas and references (C5)", () => {
    const base = derive(EVENT_ATTENDANCE);
    expect(derive(withDoc(EVENT_ATTENDANCE, { issuer: "other-org" })).credentialId).not.toBe(base.credentialId);
    expect(derive(withDoc(EVENT_ATTENDANCE, { reference: "HH-2026-ATT-000124" })).credentialId).not.toBe(
      base.credentialId,
    );
    const otherSchema = withDoc(EVENT_ATTENDANCE, {
      schema: "event-attendance.v2(string eventName,uint64 eventDate,string role)",
    });
    expect(derive(otherSchema).credentialId).not.toBe(base.credentialId);
  });

  it("computes externalCredentialId as keccak256(abi.encode(tag, schemaId, reference)) (C4)", () => {
    const schemaId = computeSchemaId(EVENT_ATTENDANCE.schema);
    expect(computeExternalCredentialId(schemaId, "HH-2026-ATT-000123")).toBe(
      keccak256(
        coder.encode(["bytes32", "bytes32", "string"], [EXTERNAL_CREDENTIAL_ID_TAG, schemaId, "HH-2026-ATT-000123"]),
      ),
    );
  });

  it("computes issuer as keccak256(bytes(name)), the registry convention", () => {
    expect(computeIssuerId("acme-university")).toBe(id("acme-university"));
    for (const bad of ["Acme", "acme university", "-acme", "acme--u", "", "a".repeat(65)]) {
      expect(() => computeIssuerId(bad)).toThrow(CredentialSchemaError);
    }
  });

  it("rejects references that do not have one byte representation", () => {
    const schemaId = computeSchemaId(EVENT_ATTENDANCE.schema);
    for (const bad of ["", " HH-1", "HH-1 ", "Cafe\u0301", "x".repeat(129)]) {
      expect(() => computeExternalCredentialId(schemaId, bad)).toThrow(CredentialSchemaError);
    }
  });
});

describe("credential schema: schemaId", () => {
  it("is keccak256 of the canonical descriptor and round-trips", () => {
    const parsed = parseSchemaDescriptor(COURSE_COMPLETION.schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(schemaDescriptor(parsed.value)).toBe(COURSE_COMPLETION.schema);
    expect(computeSchemaId(parsed.value)).toBe(keccak256(toUtf8Bytes(COURSE_COMPLETION.schema)));
    expect(computeSchemaId(COURSE_COMPLETION.schema)).toBe(computeSchemaId(parsed.value));
  });

  it("changes with the name, version, field order, field type or field name", () => {
    const ids = [
      "badge.v1(string title,uint64 earnedOn)",
      "badge.v2(string title,uint64 earnedOn)",
      "award.v1(string title,uint64 earnedOn)",
      "badge.v1(uint64 earnedOn,string title)",
      "badge.v1(string title,uint256 earnedOn)",
      "badge.v1(string name,uint64 earnedOn)",
    ].map(d => computeSchemaId(d));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("accepts only the canonical spelling", () => {
    for (const bad of [
      "badge.v1(string title, uint64 earnedOn)",
      "badge.v1(string  title)",
      "Badge.v1(string title)",
      "badge.v0(string title)",
      "badge.v01(string title)",
      "badge.v1()",
      "badge.v1(float title)",
      "badge.v1(string title,string title)",
      "badge.v1(string Title)",
      "badge(string title)",
    ]) {
      expect(parseSchemaDescriptor(bad).ok, bad).toBe(false);
    }
  });
});

describe("credential schema: subjectCommitment", () => {
  it("is keccak256(abi.encode(tag, salt, idType, idValue))", () => {
    const s = EVENT_ATTENDANCE.subject;
    expect(computeSubjectCommitment(s)).toBe(
      keccak256(
        coder.encode(["bytes32", "bytes32", "string", "string"], [SUBJECT_COMMITMENT_TAG, s.salt, s.idType, s.idValue]),
      ),
    );
  });

  it("makes two credentials of one holder unlinkable when salts differ", () => {
    const s = EVENT_ATTENDANCE.subject;
    expect(computeSubjectCommitment(s)).not.toBe(computeSubjectCommitment({ ...s, salt: generateSubjectSalt() }));
  });

  it("separates identifier types", () => {
    const s = { idType: "email", idValue: "12345", salt: "0x" + "11".repeat(32) };
    expect(computeSubjectCommitment(s)).not.toBe(computeSubjectCommitment({ ...s, idType: "student-id" }));
  });

  it("rejects a zero or missing salt and a non-normalized identifier", () => {
    const s = EVENT_ATTENDANCE.subject;
    expect(() => computeSubjectCommitment({ ...s, salt: "0x" + "0".repeat(64) })).toThrow(CredentialSchemaError);
    expect(() => computeSubjectCommitment({ ...s, salt: "" })).toThrow(CredentialSchemaError);
    expect(() => computeSubjectCommitment({ ...s, idValue: " alice@example.com" })).toThrow(CredentialSchemaError);
    expect(() => computeSubjectCommitment({ ...s, idType: "E-mail" })).toThrow(CredentialSchemaError);
  });

  it("generates 32-byte random salts", () => {
    const a = generateSubjectSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(generateSubjectSalt()).not.toBe(a);
  });
});

describe("credential schema: credentialHash", () => {
  it("is keccak256(abi.encode(tag, issuer, externalCredentialId, schemaId, subjectCommitment, issuedAt, expiresAt, claimsHash))", () => {
    const m = derive(PROFESSIONAL_CERTIFICATION);
    expect(m.credentialHash).toBe(
      keccak256(
        coder.encode(
          ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint64", "uint64", "bytes32"],
          [
            CREDENTIAL_CONTENT_TAG,
            m.issuer,
            m.externalCredentialId,
            m.schemaId,
            m.subjectCommitment,
            m.issuedAt,
            m.expiresAt,
            m.claimsHash,
          ],
        ),
      ),
    );
    expect(m.claimsHash).toBe(
      keccak256(
        coder.encode(
          ["string", "string", "uint64", "bytes32"],
          ["Cloud Solutions Architect", "professional", 1_790_000_000n, "0x" + "44".repeat(32)],
        ),
      ),
    );
    expect(computeCredentialHash(m)).toBe(m.credentialHash);
  });

  it("changes with every committed field", () => {
    const base = derive(COURSE_COMPLETION).credentialHash;
    const variants: CredentialDocument[] = [
      withDoc(COURSE_COMPLETION, { issuedAt: 1_790_000_001 }),
      withDoc(COURSE_COMPLETION, { expiresAt: 1_900_000_000 }),
      withDoc(COURSE_COMPLETION, { subject: { ...COURSE_COMPLETION.subject, idValue: "2026-000778" } }),
      ...Object.keys(COURSE_COMPLETION.claims).map(key =>
        withDoc(COURSE_COMPLETION, {
          claims: { ...COURSE_COMPLETION.claims, [key]: typeof COURSE_COMPLETION.claims[key] === "number" ? 1 : "B" },
        }),
      ),
    ];
    const hashes = variants.map(v => derive(v).credentialHash);
    expect(hashes).not.toContain(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("encodes claims with the schema's types, so strings and numbers never collide", () => {
    const a = computeClaimsHash(
      {
        name: "x",
        version: 1,
        fields: [
          { name: "a", type: "string" },
          { name: "b", type: "string" },
        ],
      },
      { a: "ab", b: "c" },
    );
    const b = computeClaimsHash(
      {
        name: "x",
        version: 1,
        fields: [
          { name: "a", type: "string" },
          { name: "b", type: "string" },
        ],
      },
      { a: "a", b: "bc" },
    );
    expect(a).not.toBe(b);
  });
});

describe("credential schema: document validation", () => {
  it("rejects claims that are missing, extra or of the wrong type", () => {
    const { role: _role, ...missing } = EVENT_ATTENDANCE.claims;
    void _role;
    expect(issuesOf(withDoc(EVENT_ATTENDANCE, { claims: missing }))).toContain("claims.role:REQUIRED");
    expect(issuesOf(withDoc(EVENT_ATTENDANCE, { claims: { ...EVENT_ATTENDANCE.claims, venue: "SP" } }))).toContain(
      "claims.venue:INCONSISTENT",
    );
    expect(
      issuesOf(withDoc(EVENT_ATTENDANCE, { claims: { ...EVENT_ATTENDANCE.claims, eventDate: "soon" } })),
    ).toContain("claims.eventDate:INVALID_FORMAT");
  });

  it("rejects non-NFC text, so one visible value has one hash", () => {
    const decomposed = "Hedera Hackathon Sa\u0303o Paulo 2026";
    expect(
      issuesOf(withDoc(EVENT_ATTENDANCE, { claims: { ...EVENT_ATTENDANCE.claims, eventName: decomposed } })),
    ).toEqual(["claims.eventName:INVALID_FORMAT"]);
  });

  it("checks dates and version", () => {
    expect(issuesOf(withDoc(EVENT_ATTENDANCE, { issuedAt: 0 }))).toContain("issuedAt:ZERO_NOT_ALLOWED");
    expect(issuesOf(withDoc(EVENT_ATTENDANCE, { expiresAt: EVENT_ATTENDANCE.issuedAt }))).toContain(
      "expiresAt:INCONSISTENT",
    );
    expect(issuesOf(withDoc(EVENT_ATTENDANCE, { version: 2 }))).toContain("version:UNSUPPORTED_VERSION");
  });

  it("reports every problem at once", () => {
    const issues = issuesOf({ version: 1, issuer: "Bad Name", schema: "nope", reference: "", subject: null });
    expect(issues).toEqual(
      expect.arrayContaining([
        "issuer:INVALID_FORMAT",
        "schema:INVALID_FORMAT",
        "reference:REQUIRED",
        "subject:REQUIRED",
        "issuedAt:REQUIRED",
      ]),
    );
  });

  it("rejects a non-object document", () => {
    expect(issuesOf("{}")).toEqual(["document:REQUIRED"]);
  });
});

describe("credential schema: expiry", () => {
  it("never expires when expiresAt is 0; otherwise expires at expiresAt", () => {
    const forever = derive(EVENT_ATTENDANCE);
    const cert = derive(PROFESSIONAL_CERTIFICATION);
    expect(isCredentialExpired(forever, 10n ** 12n)).toBe(false);
    expect(isCredentialExpired(cert, cert.expiresAt - 1n)).toBe(false);
    expect(isCredentialExpired(cert, cert.expiresAt)).toBe(true);
  });
});
