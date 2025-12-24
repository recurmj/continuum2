// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title ConsentRegistry (Continuum demo)
/// @notice Minimal RIP-002-like registry: revocation + accounting.
contract ConsentRegistry {
    mapping(bytes32 => address) public ownerOf;      // authHash -> grantor
    mapping(bytes32 => bool) public revoked;         // authHash -> revoked?
    mapping(bytes32 => uint256) public totalPulled;  // authHash -> sum(amount)
    mapping(address => bool) public trustedExecutor; // executors allowed to record

    event AuthorizationObserved(bytes32 indexed authHash, address indexed owner);
    event Revoked(bytes32 indexed authHash, address indexed owner);
    event PullRecorded(bytes32 indexed authHash, address indexed executor, uint256 amount, uint256 newTotal);
    event TrustedExecutorSet(address indexed executor, bool trusted);

    modifier onlyOwner(bytes32 authHash) {
        address o = ownerOf[authHash];
        require(o != address(0), "UNKNOWN_AUTH");
        require(msg.sender == o, "NOT_OWNER");
        _;
    }

    modifier onlyTrusted() {
        require(trustedExecutor[msg.sender], "NOT_TRUSTED_EXECUTOR");
        _;
    }

    /// @notice Controller-style admin for demo. In production you'd separate roles.
    address public controller;

    constructor(address controller_) {
        controller = controller_;
    }

    function setTrustedExecutor(address executor, bool trusted) external {
        require(msg.sender == controller, "NOT_CONTROLLER");
        trustedExecutor[executor] = trusted;
        emit TrustedExecutorSet(executor, trusted);
    }

    /// @notice Observe an authHash and bind to an owner if unset.
    /// @dev Any executor can call this preemptively; the first binding wins.
    function observe(bytes32 authHash, address owner) external onlyTrusted {
        if (ownerOf[authHash] == address(0)) {
            ownerOf[authHash] = owner;
            emit AuthorizationObserved(authHash, owner);
        }
    }

    function revoke(bytes32 authHash) external onlyOwner(authHash) {
        revoked[authHash] = true;
        emit Revoked(authHash, msg.sender);
    }

    function isRevoked(bytes32 authHash) external view returns (bool) {
        return revoked[authHash];
    }

    function recordPull(bytes32 authHash, address owner, uint256 amount) external onlyTrusted {
        // bind owner on first record
        if (ownerOf[authHash] == address(0)) {
            ownerOf[authHash] = owner;
            emit AuthorizationObserved(authHash, owner);
        }
        require(ownerOf[authHash] == owner, "OWNER_MISMATCH");
        require(!revoked[authHash], "REVOKED");

        uint256 newTotal = totalPulled[authHash] + amount;
        totalPulled[authHash] = newTotal;
        emit PullRecorded(authHash, msg.sender, amount, newTotal);
    }
}
