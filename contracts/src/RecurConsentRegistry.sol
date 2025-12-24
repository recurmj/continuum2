// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title RecurConsentRegistry
/// @notice RIP-002 Consent / Revocation Registry for permissioned-pull (RIP-001).
contract RecurConsentRegistry {
    mapping(bytes32 => bool) public revoked;
    mapping(bytes32 => uint256) public totalPulled;
    mapping(bytes32 => uint256) public capOfAuth;
    mapping(bytes32 => address) public ownerOfAuth;

    address public controller;
    mapping(address => bool) public trustedExecutor;

    event PullExecuted(
        bytes32 indexed authHash,
        address indexed token,
        address indexed grantor,
        address grantee,
        uint256 amount,
        uint256 cumulative
    );

    event AuthorizationRevoked(bytes32 indexed authHash, address indexed grantor, uint256 timestamp);
    event AuthorizationBudgetUpdated(bytes32 indexed authHash, uint256 oldCap, uint256 newCap);
    event AuthorizationObserved(bytes32 indexed authHash, address indexed grantor, address indexed grantee, address token);
    event ControllerUpdated(address indexed newController);
    event ExecutorTrusted(address indexed executor, bool trusted);
    event AuthorizationOwnerCorrected(bytes32 indexed authHash, address indexed oldOwner, address indexed newOwner);

    modifier onlyController() {
        require(msg.sender == controller, "NOT_CONTROLLER");
        _;
    }

    modifier onlyTrustedExecutor() {
        require(trustedExecutor[msg.sender], "NOT_TRUSTED_EXECUTOR");
        _;
    }

    constructor(address initialController) {
        require(initialController != address(0), "BAD_CONTROLLER");
        controller = initialController;
    }

    function setController(address next) external onlyController {
        require(next != address(0), "BAD_CONTROLLER");
        controller = next;
        emit ControllerUpdated(next);
    }

    function setTrustedExecutor(address exec, bool allowed) external onlyController {
        require(exec != address(0), "BAD_EXECUTOR");
        trustedExecutor[exec] = allowed;
        emit ExecutorTrusted(exec, allowed);
    }

    function correctAuthOwner(bytes32 authHash, address newOwner) external onlyController {
        address oldOwner = ownerOfAuth[authHash];
        ownerOfAuth[authHash] = newOwner;
        emit AuthorizationOwnerCorrected(authHash, oldOwner, newOwner);
    }

    function revoke(bytes32 authHash) external {
        address owner = ownerOfAuth[authHash];
        require(owner != address(0), "UNKNOWN_AUTH");
        require(msg.sender == owner, "NOT_GRANTOR");
        require(!revoked[authHash], "ALREADY_REVOKED");

        revoked[authHash] = true;
        emit AuthorizationRevoked(authHash, msg.sender, block.timestamp);
    }

    function observe(bytes32 authHash, address grantor, address grantee, address token) external {
        emit AuthorizationObserved(authHash, grantor, grantee, token);
    }

    function recordPull(bytes32 authHash, address token, address grantor, address grantee, uint256 amount)
        external
        onlyTrustedExecutor
    {
        require(!revoked[authHash], "AUTH_REVOKED");
        require(amount > 0, "ZERO_AMOUNT");
        require(grantor != address(0), "BAD_GRANTOR");
        require(grantee != address(0), "BAD_GRANTEE");
        require(token != address(0), "BAD_TOKEN");

        address currentOwner = ownerOfAuth[authHash];

        if (currentOwner == address(0)) {
            ownerOfAuth[authHash] = grantor;
        } else {
            require(currentOwner == grantor, "OWNER_MISMATCH");
        }

        uint256 newTotal = totalPulled[authHash] + amount;
        totalPulled[authHash] = newTotal;

        emit PullExecuted(authHash, token, grantor, grantee, amount, newTotal);
    }

    function setCap(bytes32 authHash, uint256 newCap) external {
        address owner = ownerOfAuth[authHash];
        require(owner != address(0), "UNKNOWN_AUTH");
        require(msg.sender == owner, "NOT_GRANTOR");

        uint256 oldCap = capOfAuth[authHash];
        capOfAuth[authHash] = newCap;
        emit AuthorizationBudgetUpdated(authHash, oldCap, newCap);
    }

    function isRevoked(bytes32 authHash) external view returns (bool) {
        return revoked[authHash];
    }

    function pulledTotal(bytes32 authHash) external view returns (uint256) {
        return totalPulled[authHash];
    }

    function capOf(bytes32 authHash) external view returns (uint256) {
        return capOfAuth[authHash];
    }

    function ownerOf(bytes32 authHash) external view returns (address) {
        return ownerOfAuth[authHash];
    }
}
