// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

abstract contract ReentrancyGuardMinimal {
    uint256 private _status;
    constructor() { _status = 1; }
    modifier nonReentrant() {
        require(_status == 1, "REENTRANCY");
        _status = 2;
        _;
        _status = 1;
    }
}
