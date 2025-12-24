// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {AgentWallet} from "./AgentWallet.sol";

/// @title ContinuumWorld
/// @notice Public crank for Continuum: advances ticks and asks agents to execute due pulls.
/// @dev This contract is intentionally dumb and non-discretionary.
///      It cannot move funds itself; only AgentWallets (as grantees) can call the executor.
contract ContinuumWorld {
    uint32 public tickCount;
    uint256 public startedAt;

    AgentWallet[] public agents;

    event Started(uint256 timestamp);
    event AgentAdded(address indexed agent);
    event WorldTick(uint32 indexed tick, uint256 timestamp);

    constructor() {
        startedAt = block.timestamp;
        emit Started(block.timestamp);
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function addAgent(address agent) external {
        // For v0, permissionless. If you want, you can later gate to an owner.
        require(agent != address(0), "BAD_AGENT");
        agents.push(AgentWallet(agent));
        emit AgentAdded(agent);
    }

    /// @notice Advance the world by 1 tick and invoke each agent's tick(currentTick).
    function tick() external {
        tickCount += 1;
        uint32 t = tickCount;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            agents[i].tick(t);
        }

        emit WorldTick(t, block.timestamp);
    }
}
