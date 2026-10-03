// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AccreditationRegistry
/// @notice Public record of which AnonCreds credential definitions an accreditation authority recognizes for a course.
/// Relying parties read it to decide which issuers to trust, at a point in time.
/// @dev It holds no certificate and no revocation state: whether a certificate is valid is decided by its AnonCreds
/// proof, checked against the issuer's objects on Hedera (HCS). A withdrawn definition stays withdrawn, so
/// `isAccredited` answers exactly for any past time.
contract AccreditationRegistry {
    struct Accreditation {
        uint64 grantedAt;
        uint64 withdrawnAt;
    }

    /// @notice The accreditation body: the only account that can accredit or withdraw.
    address public immutable authority;

    mapping(bytes32 course => string[] credentialDefinitionIds) private _definitions;
    mapping(bytes32 course => mapping(bytes32 credentialDefinition => Accreditation)) private _accreditations;

    event Accredited(string course, string credentialDefinitionId, uint64 grantedAt);
    event Withdrawn(string course, string credentialDefinitionId, uint64 withdrawnAt);

    error NotAuthority();
    error EmptyValue();
    error AlreadyAccredited();
    error NotAccredited();

    constructor() {
        authority = msg.sender;
    }

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority();
        _;
    }

    /// @notice Recognizes `credentialDefinitionId` as a valid issuer of `course` certificates from now on.
    function accredit(string calldata course, string calldata credentialDefinitionId) external onlyAuthority {
        if (bytes(course).length == 0 || bytes(credentialDefinitionId).length == 0) revert EmptyValue();
        Accreditation storage accreditation = _entry(course, credentialDefinitionId);
        if (accreditation.grantedAt != 0) revert AlreadyAccredited();
        accreditation.grantedAt = uint64(block.timestamp);
        _definitions[keccak256(bytes(course))].push(credentialDefinitionId);
        emit Accredited(course, credentialDefinitionId, accreditation.grantedAt);
    }

    /// @notice Stops recognizing `credentialDefinitionId` for `course` from now on. Past recognition is kept.
    function withdraw(string calldata course, string calldata credentialDefinitionId) external onlyAuthority {
        Accreditation storage accreditation = _entry(course, credentialDefinitionId);
        if (accreditation.grantedAt == 0 || accreditation.withdrawnAt != 0) revert NotAccredited();
        accreditation.withdrawnAt = uint64(block.timestamp);
        emit Withdrawn(course, credentialDefinitionId, accreditation.withdrawnAt);
    }

    /// @notice Every definition ever accredited for `course`, in order, withdrawn ones included.
    function credentialDefinitions(string calldata course) external view returns (string[] memory) {
        return _definitions[keccak256(bytes(course))];
    }

    /// @notice Whether `credentialDefinitionId` was accredited for `course` at Unix time `at` (seconds).
    function isAccredited(
        string calldata course,
        string calldata credentialDefinitionId,
        uint64 at
    ) external view returns (bool) {
        Accreditation memory accreditation = _entry(course, credentialDefinitionId);
        return
            accreditation.grantedAt != 0 &&
            accreditation.grantedAt <= at &&
            (accreditation.withdrawnAt == 0 || at < accreditation.withdrawnAt);
    }

    function _entry(string calldata course, string calldata id) private view returns (Accreditation storage) {
        return _accreditations[keccak256(bytes(course))][keccak256(bytes(id))];
    }
}
