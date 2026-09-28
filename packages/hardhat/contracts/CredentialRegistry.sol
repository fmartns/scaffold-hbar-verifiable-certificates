// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ICredentialRegistry, CredentialEvent, HcsRef, IssuerConfig, CredentialStatus, CredentialRecord } from "./interfaces/ICredentialRegistry.sol";

/// @title CredentialRegistry
/// @notice Authoritative on-chain state of verifiable credentials: issued once per `credentialId`, revocable only by the
/// issuing namespace's current signer or by `ADMIN_ROLE`. HCS carries the evidence; this contract decides validity.
/// @dev Admin powers are configuration only: no role can issue, and no role can change the hash, subject, issuer or
/// signer of an existing record. Admin cannot rotate an existing issuer's signer, so it cannot forge issuance under a
/// namespace it does not control.
contract CredentialRegistry is ICredentialRegistry, AccessControl, EIP712 {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint16 public constant CREDENTIAL_EVENT_VERSION = 1;
    uint64 public constant MAX_CLOCK_SKEW = 30;
    uint64 public constant MAX_VALIDITY_CEILING = 30 days;

    string public constant EIP712_NAME = "HederaVerifiableCredentials";
    string public constant EIP712_VERSION = "1";

    bytes32 public constant CREDENTIAL_KEY_TAG = keccak256("hedera-verifiable-credentials.credential.v1");
    bytes32 public constant CREDENTIAL_EVENT_TYPEHASH =
        keccak256(
            "CredentialEvent(uint16 version,bytes32 issuer,bytes32 externalCredentialId,bytes32 credentialHash,bytes32 subjectCommitment,bytes32 schemaId,uint64 signedAt,uint64 validUntil,address submitter)"
        );

    uint64 public immutable hcsTopicNum;
    bool public paused;

    mapping(bytes32 issuer => IssuerConfig) private _issuers;
    mapping(bytes32 credentialId => CredentialRecord) private _records;

    constructor(address admin, uint64 hcsTopicNum_) EIP712(EIP712_NAME, EIP712_VERSION) {
        if (admin == address(0)) revert InvalidField("admin");
        hcsTopicNum = hcsTopicNum_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Issuance
    // -----------------------------------------------------------------------------------------------------------------

    /// @notice Registers a credential signed by the issuer's registered signer. Permissionless: the signature is the
    /// authority, the caller is only a relayer (unless `e.submitter` pins it).
    function issue(
        CredentialEvent calldata e,
        bytes calldata signature,
        HcsRef calldata hcs
    ) external returns (bytes32 credentialId) {
        if (paused) revert Paused();
        _checkStructure(e, hcs);

        IssuerConfig memory cfg = _issuers[e.issuer];
        if (cfg.signer == address(0)) revert UnknownIssuer(e.issuer);
        if (!cfg.active) revert InactiveIssuer(e.issuer);

        bytes32 digest = _hashTypedDataV4(_hashStruct(e));
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature();
        if (recovered != cfg.signer) revert UnauthorizedSigner(recovered, cfg.signer);

        // Uniqueness is checked after authenticity, so a conflict always means a validly signed equivocation.
        credentialId = computeCredentialId(e.issuer, e.externalCredentialId);
        CredentialRecord storage record = _records[credentialId];
        if (record.status != CredentialStatus.None) {
            if (record.credentialHash == e.credentialHash && record.subjectCommitment == e.subjectCommitment) {
                revert AlreadyIssued(credentialId, record.issuedAt);
            }
            revert ConflictingCredential(credentialId, record.credentialHash, e.credentialHash);
        }

        _checkFreshness(e, cfg.maxValidity);

        record.issuer = e.issuer;
        record.credentialHash = e.credentialHash;
        record.subjectCommitment = e.subjectCommitment;
        record.signer = recovered;
        record.issuedAt = uint64(block.timestamp);
        record.status = CredentialStatus.Issued;

        _emitIssued(credentialId, e, digest, recovered, hcs);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Revocation
    // -----------------------------------------------------------------------------------------------------------------

    /// @notice Revokes a credential. Allowed for the issuing namespace's current, active signer, or for `ADMIN_ROLE`.
    /// Works while paused. Revocation is final: a revoked `credentialId` can never be issued again.
    function revoke(bytes32 credentialId) external {
        CredentialRecord storage record = _records[credentialId];
        if (record.status == CredentialStatus.None) revert UnknownCredential(credentialId);
        if (record.status == CredentialStatus.Revoked) revert AlreadyRevoked(credentialId, record.revokedAt);

        IssuerConfig memory cfg = _issuers[record.issuer];
        bool byIssuer = cfg.active && msg.sender == cfg.signer;
        bool byAdmin = !byIssuer && hasRole(ADMIN_ROLE, msg.sender);
        if (!byIssuer && !byAdmin) revert UnauthorizedRevoker(credentialId, msg.sender);

        record.status = CredentialStatus.Revoked;
        record.revokedAt = uint64(block.timestamp);

        emit CredentialRevoked(credentialId, record.issuer, msg.sender, byAdmin, record.revokedAt);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Issuer registry
    // -----------------------------------------------------------------------------------------------------------------

    /// @notice Registers a new issuer namespace. A namespace is registered once; its signer is then rotated only by itself.
    function registerIssuer(bytes32 issuer, address signer, uint64 maxValidity) external onlyRole(ADMIN_ROLE) {
        if (issuer == bytes32(0)) revert InvalidField("issuer");
        if (signer == address(0)) revert InvalidField("signer");
        _checkMaxValidity(maxValidity);
        if (_issuers[issuer].signer != address(0)) revert IssuerAlreadyRegistered(issuer);

        _issuers[issuer] = IssuerConfig({ signer: signer, active: true, maxValidity: maxValidity });
        emit IssuerRegistered(issuer, signer, maxValidity);
    }

    function setIssuerActive(bytes32 issuer, bool active) external onlyRole(ADMIN_ROLE) {
        IssuerConfig storage cfg = _registeredIssuer(issuer);
        cfg.active = active;
        emit IssuerActiveSet(issuer, active);
    }

    function setIssuerMaxValidity(bytes32 issuer, uint64 maxValidity) external onlyRole(ADMIN_ROLE) {
        _checkMaxValidity(maxValidity);
        IssuerConfig storage cfg = _registeredIssuer(issuer);
        cfg.maxValidity = maxValidity;
        emit IssuerMaxValiditySet(issuer, maxValidity);
    }

    /// @notice Key rotation by the issuer itself. Signatures by the previous signer stop being accepted immediately,
    /// and the previous signer loses the power to revoke.
    function rotateIssuerSigner(bytes32 issuer, address newSigner) external {
        IssuerConfig storage cfg = _registeredIssuer(issuer);
        if (msg.sender != cfg.signer) revert NotIssuerSigner(issuer, msg.sender);
        if (!cfg.active) revert InactiveIssuer(issuer);
        if (newSigner == address(0)) revert InvalidField("signer");

        address previous = cfg.signer;
        cfg.signer = newSigner;
        emit IssuerSignerRotated(issuer, previous, newSigner);
    }

    /// @notice Blocks issuance only. Revocation and issuer key rotation stay available during an incident.
    function setPaused(bool paused_) external onlyRole(ADMIN_ROLE) {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------------------------------

    /// @notice Source of truth for verifiers. `status == None` means the credential was never issued here.
    function statusOf(bytes32 credentialId) external view returns (CredentialRecord memory) {
        return _records[credentialId];
    }

    function issuerOf(bytes32 issuer) external view returns (IssuerConfig memory) {
        return _issuers[issuer];
    }

    /// @notice `keccak256(abi.encode(CREDENTIAL_KEY_TAG, issuer, externalCredentialId))`. Not bound to chain or
    /// deployment, so the same credential has the same id in every audit.
    function computeCredentialId(bytes32 issuer, bytes32 externalCredentialId) public pure returns (bytes32) {
        return keccak256(abi.encode(CREDENTIAL_KEY_TAG, issuer, externalCredentialId));
    }

    /// @notice EIP-712 digest the issuer signs, bound to this chain and this contract.
    function hashCredentialEvent(CredentialEvent calldata e) external view returns (bytes32) {
        return _hashTypedDataV4(_hashStruct(e));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------------------------------------------------

    function _hashStruct(CredentialEvent calldata e) private pure returns (bytes32) {
        return keccak256(abi.encode(CREDENTIAL_EVENT_TYPEHASH, e));
    }

    function _emitIssued(
        bytes32 credentialId,
        CredentialEvent calldata e,
        bytes32 digest,
        address signer,
        HcsRef calldata hcs
    ) private {
        emit CredentialIssued(
            credentialId,
            e.issuer,
            e.subjectCommitment,
            e.credentialHash,
            e.schemaId,
            digest,
            signer,
            e.signedAt,
            hcs.sequence,
            hcs.consensusTimestampNs
        );
    }

    function _checkStructure(CredentialEvent calldata e, HcsRef calldata hcs) private view {
        if (e.version != CREDENTIAL_EVENT_VERSION) revert UnsupportedVersion(e.version);
        if (e.issuer == bytes32(0)) revert InvalidField("issuer");
        if (e.externalCredentialId == bytes32(0)) revert InvalidField("externalCredentialId");
        if (e.credentialHash == bytes32(0)) revert InvalidField("credentialHash");
        if (e.subjectCommitment == bytes32(0)) revert InvalidField("subjectCommitment");
        if (e.schemaId == bytes32(0)) revert InvalidField("schemaId");
        if (e.validUntil <= e.signedAt) revert InvalidField("validUntil");
        if (hcs.sequence == 0) revert InvalidField("hcs.sequence");
        if (e.submitter != address(0) && e.submitter != msg.sender) revert SubmitterMismatch(e.submitter, msg.sender);
    }

    function _checkFreshness(CredentialEvent calldata e, uint64 maxValidity) private view {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs > e.validUntil) revert Expired(e.validUntil, nowTs);
        if (e.signedAt > nowTs + MAX_CLOCK_SKEW) revert SignedInFuture(e.signedAt, nowTs);
        uint64 window = e.validUntil - e.signedAt;
        if (window > maxValidity) revert ValidityWindowTooLong(window, maxValidity);
    }

    function _checkMaxValidity(uint64 maxValidity) private pure {
        if (maxValidity == 0 || maxValidity > MAX_VALIDITY_CEILING) revert InvalidField("maxValidity");
    }

    function _registeredIssuer(bytes32 issuer) private view returns (IssuerConfig storage cfg) {
        cfg = _issuers[issuer];
        if (cfg.signer == address(0)) revert UnknownIssuer(issuer);
    }
}
