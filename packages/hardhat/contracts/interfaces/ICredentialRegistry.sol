// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Signed issuance of one verifiable credential. Every field is static so the EIP-712 `encodeData` of the
/// struct is exactly `abi.encode` of its fields; adding a dynamic field is a new `version` and a new type string.
struct CredentialEvent {
    uint16 version;
    /// @dev Registered issuer namespace: `keccak256(bytes(<lowercase ASCII organization name>))`.
    bytes32 issuer;
    /// @dev Identity of the credential within the issuer; a pure function of its identifying fields (never JSON).
    bytes32 externalCredentialId;
    /// @dev Hash of the off-chain credential document. The document itself never goes on-chain.
    bytes32 credentialHash;
    /// @dev Salted commitment to the subject. Never a raw identifier or personal data.
    bytes32 subjectCommitment;
    bytes32 schemaId;
    /// @dev Unix seconds: when the issuer signed.
    uint64 signedAt;
    /// @dev Unix seconds: expiry of this signed issuance (not of the credential).
    uint64 validUntil;
    /// @dev `address(0)` lets any caller submit.
    address submitter;
}

/// @notice Publisher's claim of where the attestation sits in HCS. The contract cannot read HCS: it is emitted, never verified.
struct HcsRef {
    uint64 sequence;
    uint64 consensusTimestampNs;
}

struct IssuerConfig {
    address signer;
    bool active;
    uint64 maxValidity;
}

enum CredentialStatus {
    None,
    Issued,
    Revoked
}

struct CredentialRecord {
    bytes32 issuer;
    bytes32 credentialHash;
    bytes32 subjectCommitment;
    address signer;
    uint64 issuedAt;
    uint64 revokedAt;
    CredentialStatus status;
}

interface ICredentialRegistry {
    event CredentialIssued(
        bytes32 indexed credentialId,
        bytes32 indexed issuer,
        bytes32 indexed subjectCommitment,
        bytes32 credentialHash,
        bytes32 schemaId,
        bytes32 attestationDigest,
        address signer,
        uint64 signedAt,
        uint64 hcsSequence,
        uint64 hcsConsensusTimestampNs
    );
    event CredentialRevoked(
        bytes32 indexed credentialId,
        bytes32 indexed issuer,
        address indexed revokedBy,
        bool byAdmin,
        uint64 revokedAt
    );
    event IssuerRegistered(bytes32 indexed issuer, address signer, uint64 maxValidity);
    event IssuerSignerRotated(bytes32 indexed issuer, address previousSigner, address newSigner);
    event IssuerActiveSet(bytes32 indexed issuer, bool active);
    event IssuerMaxValiditySet(bytes32 indexed issuer, uint64 maxValidity);
    event PausedSet(bool paused);

    error Paused();
    error UnsupportedVersion(uint16 got);
    error InvalidField(bytes32 field);
    error SubmitterMismatch(address expected, address actual);
    error UnknownIssuer(bytes32 issuer);
    error InactiveIssuer(bytes32 issuer);
    error IssuerAlreadyRegistered(bytes32 issuer);
    error NotIssuerSigner(bytes32 issuer, address caller);
    error InvalidSignature();
    error UnauthorizedSigner(address recovered, address expected);
    error AlreadyIssued(bytes32 credentialId, uint64 issuedAt);
    error ConflictingCredential(bytes32 credentialId, bytes32 storedCredentialHash, bytes32 submittedCredentialHash);
    error Expired(uint64 validUntil, uint64 nowTs);
    error SignedInFuture(uint64 signedAt, uint64 nowTs);
    error ValidityWindowTooLong(uint64 window, uint64 max);
    error UnknownCredential(bytes32 credentialId);
    error AlreadyRevoked(bytes32 credentialId, uint64 revokedAt);
    error UnauthorizedRevoker(bytes32 credentialId, address caller);

    function issue(
        CredentialEvent calldata e,
        bytes calldata signature,
        HcsRef calldata hcs
    ) external returns (bytes32 credentialId);

    function revoke(bytes32 credentialId) external;

    function statusOf(bytes32 credentialId) external view returns (CredentialRecord memory);

    function issuerOf(bytes32 issuer) external view returns (IssuerConfig memory);

    function computeCredentialId(bytes32 issuer, bytes32 externalCredentialId) external pure returns (bytes32);

    function hashCredentialEvent(CredentialEvent calldata e) external view returns (bytes32 attestationDigest);

    function hcsTopicNum() external view returns (uint64);
}
