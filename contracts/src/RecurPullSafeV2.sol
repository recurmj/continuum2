// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ReentrancyGuardMinimal} from "./ReentrancyGuardMinimal.sol";
import {IERC20Minimal, SafeERC20Minimal} from "./ERC20Minimal.sol";
import {LibECDSA} from "./LibECDSA.sol";

interface IRecurConsentRegistry {
    function isRevoked(bytes32 authHash) external view returns (bool);
    function recordPull(bytes32 authHash, address token, address grantor, address grantee, uint256 amount) external;
}

interface IEIP1271 {
    function isValidSignature(bytes32 _hash, bytes calldata _signature) external view returns (bytes4 magicValue);
}

contract RecurPullSafeV2 is ReentrancyGuardMinimal {
    using SafeERC20Minimal for IERC20Minimal;

    struct Authorization {
        address grantor;
        address grantee;
        address token;
        uint256 maxPerPull;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes   signature;
    }

    IRecurConsentRegistry public immutable registry;
    bytes32 private immutable _DOMAIN_SEPARATOR;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant _AUTH_TYPEHASH =
        keccak256(
            "Authorization(address grantor,address grantee,address token,uint256 maxPerPull,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    event PullExecutedDirect(bytes32 indexed authHash, address indexed token, address indexed grantor, address grantee, uint256 amount);
    event EIP1271ValidationError(address indexed wallet, bytes32 indexed digest, bytes data);

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

    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

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

        require(_verifyGrantorSig(auth, auth.signature), "BAD_SIG");

        IERC20Minimal(auth.token).safeTransferFrom(auth.grantor, auth.grantee, amount);

        emit PullExecutedDirect(authHash, auth.token, auth.grantor, auth.grantee, amount);

        registry.recordPull(authHash, auth.token, auth.grantor, auth.grantee, amount);
    }

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

    function _verifyGrantorSig(Authorization calldata auth, bytes calldata signature) internal view returns (bool) {
        bytes32 structHash = _hashAuthorizationStruct(auth);
        bytes32 digest = _eip712Digest(structHash);

        if (auth.grantor.code.length != 0) {
            (bool ok, bytes memory returndata) =
                auth.grantor.staticcall(
                    abi.encodeWithSelector(IEIP1271.isValidSignature.selector, digest, signature)
                );

            if (!ok || returndata.length != 32) {
                emit EIP1271ValidationError(auth.grantor, digest, returndata);
                return false;
            }
            bytes4 magicVal = abi.decode(returndata, (bytes4));
            return (magicVal == 0x1626ba7e);
        }

        if (signature.length != 65) return false;
        try LibECDSA.recover(digest, bytes(signature)) returns (address recovered) {
            return recovered == auth.grantor;
        } catch {
            return false;
        }
    }
}
