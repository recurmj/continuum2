// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title RecurPullSafeV2
/// @notice RIP-001 permissioned pull executor with RIP-002 registry integration,
///         EIP-712 authorization, and EIP-1271 smart wallet support.
/// @dev
/// Non-custodial: transfers ERC20 directly from grantor -> grantee (no escrow).
/// Registry is used as the global revocation + accounting source of truth.
///
/// This version fixes the compile error caused by `try/catch` around a library call:
/// - Solidity only allows try/catch for *external calls* or *contract creation*.
/// - So we do EOA signature verification with direct `ecrecover` + EIP-2 low-s checks,
///   and keep the EIP-1271 path as an external `staticcall`.

import {ReentrancyGuardMinimal} from "./ReentrancyGuardMinimal.sol";
import {IERC20Minimal, SafeERC20Minimal} from "./ERC20Minimal.sol";

/// @notice Light interface to the Consent Registry (RIP-002).
interface IRecurConsentRegistry {
    function isRevoked(bytes32 authHash) external view returns (bool);

    function recordPull(
        bytes32 authHash,
        address token,
        address grantor,
        address grantee,
        uint256 amount
    ) external;
}

/// @notice Smart contract wallet signature validator (EIP-1271-style).
interface IEIP1271 {
    function isValidSignature(bytes32 _hash, bytes calldata _signature)
        external
        view
        returns (bytes4 magicValue);
}

contract RecurPullSafeV2 is ReentrancyGuardMinimal {
    using SafeERC20Minimal for IERC20Minimal;

    /// -----------------------------------------------------------------------
    /// Authorization struct
    /// -----------------------------------------------------------------------

    /// @notice Off-chain signed grant of consent.
    /// @dev
    /// - `grantee` is BOTH (1) who may call pull() and (2) who receives funds.
    struct Authorization {
        address grantor;      // wallet giving consent / paying funds
        address grantee;      // wallet allowed to pull AND the receiver of funds
        address token;        // ERC-20 being pulled
        uint256 maxPerPull;   // hard ceiling for a single pull() call
        uint256 validAfter;   // earliest timestamp allowed
        uint256 validBefore;  // latest timestamp allowed
        bytes32 nonce;        // unique salt (prevents collisions / replay across grants)
        bytes   signature;    // EIP-712 / 1271 signature by grantor
    }

    /// -----------------------------------------------------------------------
    /// Immutable storage
    /// -----------------------------------------------------------------------

    IRecurConsentRegistry public immutable registry;
    bytes32 private immutable _DOMAIN_SEPARATOR;

    /// @dev keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev keccak256("Authorization(address grantor,address grantee,address token,uint256 maxPerPull,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 private constant _AUTH_TYPEHASH =
        keccak256(
            "Authorization(address grantor,address grantee,address token,uint256 maxPerPull,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    /// @dev secp256k1n / 2 (EIP-2): s must be in lower half-order to prevent malleability
    uint256 private constant _SECP256K1N_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// -----------------------------------------------------------------------
    /// Events
    /// -----------------------------------------------------------------------

    event PullExecutedDirect(
        bytes32 indexed authHash,
        address indexed token,
        address indexed grantor,
        address grantee,
        uint256 amount
    );

    event EIP1271ValidationError(
        address indexed wallet,
        bytes32 indexed digest,
        bytes data
    );

    /// -----------------------------------------------------------------------
    /// Constructor
    /// -----------------------------------------------------------------------

    constructor(address registryAddr) {
        require(registryAddr != address(0), "BAD_REGISTRY");
        registry = IRecurConsentRegistry(registryAddr);

        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("RecurPullSafeV2")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// -----------------------------------------------------------------------
    /// Public views
    /// -----------------------------------------------------------------------

    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    /// @notice Compute canonical authHash for registry lookups / audit trail.
    /// @dev Signature is excluded.
    function authHashOf(Authorization calldata auth) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                auth.grantor,
                auth.grantee,
                auth.token,
                auth.maxPerPull,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
    }

    /// -----------------------------------------------------------------------
    /// External entrypoint
    /// -----------------------------------------------------------------------

    function pull(Authorization calldata auth, uint256 amount) external nonReentrant {
        require(amount > 0, "AMOUNT_0");
        require(auth.grantor != address(0), "BAD_GRANTOR");
        require(auth.grantee != address(0), "BAD_GRANTEE");
        require(auth.token != address(0), "BAD_TOKEN");

        bytes32 authHash = authHashOf(auth);

        require(!registry.isRevoked(authHash), "REVOKED");
        require(msg.sender == auth.grantee, "NOT_AUTHORIZED");

        require(block.timestamp >= auth.validAfter, "TOO_SOON");
        require(block.timestamp <= auth.validBefore, "EXPIRED");
        require(amount <= auth.maxPerPull, "LIMIT");

        require(_verifyGrantorSig(auth), "BAD_SIG");

        // Direct, non-custodial transfer: grantor -> grantee
        IERC20Minimal(auth.token).safeTransferFrom(auth.grantor, auth.grantee, amount);

        emit PullExecutedDirect(authHash, auth.token, auth.grantor, auth.grantee, amount);

        // Accounting + binding of authHash -> grantor happens in registry
        registry.recordPull(authHash, auth.token, auth.grantor, auth.grantee, amount);
    }

    /// -----------------------------------------------------------------------
    /// Internal: EIP-712 hashing + signature verification
    /// -----------------------------------------------------------------------

    function _hashAuthorizationStruct(Authorization calldata auth) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _AUTH_TYPEHASH,
                auth.grantor,
                auth.grantee,
                auth.token,
                auth.maxPerPull,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
    }

    function _eip712Digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));
    }

    function _verifyGrantorSig(Authorization calldata auth) internal view returns (bool) {
        bytes32 structHash = _hashAuthorizationStruct(auth);
        bytes32 digest = _eip712Digest(structHash);
        bytes calldata signature = auth.signature;

        // EIP-1271 path (contract wallets)
        if (auth.grantor.code.length != 0) {
            (bool ok, bytes memory returndata) = auth.grantor.staticcall(
                abi.encodeWithSelector(IEIP1271.isValidSignature.selector, digest, signature)
            );

            if (!ok || returndata.length != 32) {
                emit EIP1271ValidationError(auth.grantor, digest, returndata);
                return false;
            }

            bytes4 magicVal = abi.decode(returndata, (bytes4));
            return (magicVal == 0x1626ba7e);
        }

        // EOA path (ECDSA with low-s enforcement)
        if (signature.length != 65) return false;

        bytes32 r;
        bytes32 s;
        uint8 v;

        // copy to memory for predictable loads
        bytes memory sig = signature;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }

        // normalize v: allow {0,1} or {27,28}
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return false;

        // reject malleable s (EIP-2)
        if (uint256(s) > _SECP256K1N_HALF_ORDER) return false;

        address recovered = ecrecover(digest, v, r, s);
        return (recovered != address(0) && recovered == auth.grantor);
    }
}
