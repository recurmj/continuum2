// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {AgentWallet} from "./AgentWallet.sol";

/// @title ContinuumWorld
/// @notice Public crank for Continuum: advances ticks and asks agents to execute due pulls.
/// @dev This contract is intentionally dumb and non-discretionary.
///      It cannot move funds itself; only AgentWallets (as grantees) can call the executor.
///
///      IMPORTANT FIX:
///      - tick() is "strict": if any agent reverts, the whole tick reverts.
///      - tickSafe() is "best-effort": continues even if some agents revert.
contract ContinuumWorld {
    uint32 public tickCount;
    uint256 public startedAt;

    // Optional throttle to prevent rapid spamming (esp. on public chains)
    uint64 public immutable minTickSeconds;
    uint256 public lastTickAt;

    AgentWallet[] public agents;

    event Started(uint256 timestamp);
    event AgentAdded(address indexed agent);
    event WorldTick(uint32 indexed tick, uint256 timestamp);

    // New: visibility for failures (no revert)
    event AgentTickFailed(uint32 indexed tick, address indexed agent, bytes data);

    constructor(uint64 _minTickSeconds) {
        startedAt = block.timestamp;
        minTickSeconds = _minTickSeconds;
        emit Started(block.timestamp);
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function addAgent(address agent) external {
        require(agent != address(0), "BAD_AGENT");
        agents.push(AgentWallet(agent));
        emit AgentAdded(agent);
    }

    /// @notice Strict tick: reverts if any agent reverts.
    function tick() external {
        _throttle();

        tickCount += 1;
        uint32 t = tickCount;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            agents[i].tick(t);
        }

        emit WorldTick(t, block.timestamp);
    }

    /// @notice Safe tick: continues even if some agents revert.
    function tickSafe() external {
        _throttle();

        tickCount += 1;
        uint32 t = tickCount;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            try agents[i].tick(t) {
                // ok
            } catch (bytes memory data) {
                emit AgentTickFailed(t, address(agents[i]), data);
            }
        }

        emit WorldTick(t, block.timestamp);
    }

    function _throttle() internal {
        // allow first tick immediately
        if (lastTickAt != 0 && minTickSeconds != 0) {
            require(block.timestamp >= lastTickAt + minTickSeconds, "TICK_TOO_SOON");
        }
        lastTickAt = block.timestamp;
    }
}
