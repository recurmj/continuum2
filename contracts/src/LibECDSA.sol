// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice Minimal ECDSA recover with strict malleability checks (low-s) and v normalization.
library LibECDSA {
    // secp256k1n
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // half of secp256k1n
    uint256 internal constant SECP256K1_N_HALF = SECP256K1_N / 2;

    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSigLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        // Normalize v
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSigV();

        // Enforce low-s to prevent malleability
        uint256 sNum = uint256(s);
        if (sNum == 0 || sNum > SECP256K1_N_HALF) revert InvalidSigS();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSigRecover();
        return signer;
    }

    error InvalidSigLength();
    error InvalidSigV();
    error InvalidSigS();
    error InvalidSigRecover();
}
