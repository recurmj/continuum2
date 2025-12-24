// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {LibECDSA} from "./LibECDSA.sol";
import {ConsentRegistry} from "./ConsentRegistry.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PullExecutor (Continuum demo)
/// @notice EIP-712 executor for Permissioned Pull Objects (PPOs).
contract PullExecutor {
    struct Authorization {
        bytes32 nonce;
        address grantor;
        address grantee;
        address token;
        uint256 maxPerPull;
        uint256 validAfter;
        uint256 validBefore;
    }

    bytes32 public constant AUTH_TYPEHASH = keccak256(
        "Authorization(bytes32 nonce,address grantor,address grantee,address token,uint256 maxPerPull,uint256 validAfter,uint256 validBefore)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;
    ConsentRegistry public immutable registry;

    event Pulled(bytes32 indexed authHash, address indexed grantor, address indexed grantee, address token, uint256 amount);

    constructor(ConsentRegistry registry_, string memory name_, string memory version_) {
        registry = registry_;
        DOMAIN_SEPARATOR = _domainSeparator(name_, version_);
    }

    function domainSeparator() external view returns (bytes32) { return DOMAIN_SEPARATOR; }

    function authHash(Authorization calldata a) public pure returns (bytes32) {
        return keccak256(abi.encode(AUTH_TYPEHASH, a.nonce, a.grantor, a.grantee, a.token, a.maxPerPull, a.validAfter, a.validBefore));
    }

    function digest(Authorization calldata a) public view returns (bytes32) {
        bytes32 sh = authHash(a);
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, sh));
    }

    function pull(Authorization calldata a, uint256 amount, bytes calldata sig) external {
        require(amount <= a.maxPerPull, "OVER_CAP");
        uint256 t = block.timestamp;
        require(t >= a.validAfter && t <= a.validBefore, "OUTSIDE_WINDOW");

        bytes32 sh = authHash(a);

        // Ensure not revoked and bind owner (grantor) in registry.
        registry.recordPull(sh, a.grantor, 0); // observe/bind owner + check revoked

        // Verify signature.
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, sh));
        address signer = LibECDSA.recover(d, sig);
        require(signer == a.grantor, "BAD_SIG");

        // Execute pull.
        bool ok = IERC20(a.token).transferFrom(a.grantor, a.grantee, amount);
        require(ok, "TRANSFER_FROM_FAILED");

        // Record amount (trusted executor restriction can be added later; for demo it's open).
        registry.recordPull(sh, a.grantor, amount);

        emit Pulled(sh, a.grantor, a.grantee, a.token, amount);
    }

    function _domainSeparator(string memory name_, string memory version_) internal view returns (bytes32) {
        // EIP-712 Domain: name, version, chainId, verifyingContract
        bytes32 EIP712DOMAIN_TYPEHASH = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        return keccak256(
            abi.encode(
                EIP712DOMAIN_TYPEHASH,
                keccak256(bytes(name_)),
                keccak256(bytes(version_)),
                block.chainid,
                address(this)
            )
        );
    }
}
