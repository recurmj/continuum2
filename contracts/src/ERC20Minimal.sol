// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

library SafeERC20Minimal {
    function safeTransferFrom(IERC20Minimal token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        require(ok, "TRANSFERFROM_REVERT");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "TRANSFERFROM_FALSE");
        }
    }

    function safeApprove(IERC20Minimal token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount)
        );
        require(ok, "APPROVE_REVERT");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "APPROVE_FALSE");
        }
    }
}
