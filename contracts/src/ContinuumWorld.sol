// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {AgentWallet} from "./AgentWallet.sol";

/// @title ContinuumWorld
/// @notice Public crank for Continuum: advances ticks and asks agents to execute due pulls.
/// @dev Safe-crank: a single agent failure MUST NOT revert the world tick.
///      This contract cannot move funds; only AgentWallets execute pulls.
contract ContinuumWorld {
    uint32 public tickCount;
    uint256 public startedAt;

    // Optional: throttle public ticking (set to 0 to disable)
    uint256 public minTickIntervalSeconds;
    uint256 public lastTickAt;

    AgentWallet[] public agents;
    mapping(address => bool) public isAgent;

    event Started(uint256 timestamp);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event WorldTick(uint32 indexed tick, uint256 timestamp);

    // Emitted when an agent reverts during a safe tick
    event AgentTickFailed(uint32 indexed tick, address indexed agent, bytes revertData);

    constructor() {
        startedAt = block.timestamp;
        emit Started(block.timestamp);
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    /// @notice Set a minimum time between ticks. Set to 0 to disable throttling.
    /// @dev Permissionless for v0. If you want, gate this later (owner/controller).
    function setMinTickInterval(uint256 seconds_) external {
        minTickIntervalSeconds = seconds_;
    }

    function addAgent(address agent) external {
        require(agent != address(0), "BAD_AGENT");
        require(!isAgent[agent], "DUP_AGENT");
        isAgent[agent] = true;
        agents.push(AgentWallet(agent));
        emit AgentAdded(agent);
    }

    /// @notice Optional remove (swap-and-pop). Permissionless for v0.
    function removeAgent(address agent) external {
        require(isAgent[agent], "NOT_AGENT");
        isAgent[agent] = false;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            if (address(agents[i]) == agent) {
                agents[i] = agents[len - 1];
                agents.pop();
                emit AgentRemoved(agent);
                return;
            }
        }

        // Should be unreachable if isAgent is consistent, but keep sane:
        revert("NOT_FOUND");
    }

    /// @notice Unsafe tick (kept for compatibility). Any agent revert will revert the whole tick.
    function tick() external {
        tickCount += 1;
        uint32 t = tickCount;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            agents[i].tick(t);
        }

        emit WorldTick(t, block.timestamp);
    }

    /// @notice Safe tick: advances time and invokes agents; never reverts due to agent failures.
    function tickSafe() external {
        _throttle();

        tickCount += 1;
        uint32 t = tickCount;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            address a = address(agents[i]);
            if (!isAgent[a]) continue;

            try agents[i].tick(t) {
                // ok
            } catch (bytes memory data) {
                emit AgentTickFailed(t, a, data);
            }
        }

        emit WorldTick(t, block.timestamp);
    }

    /// @notice Batch safe ticks to reduce RPC/mempool churn (e.g. tickRange(5))
    function tickRange(uint32 n) external {
        require(n > 0 && n <= 50, "BAD_N");
        for (uint32 i = 0; i < n; i++) {
            tickSafe();
        }
    }

    function _throttle() internal {
        uint256 minI = minTickIntervalSeconds;
        if (minI != 0) {
            require(block.timestamp >= lastTickAt + minI, "TOO_FAST");
        }
        lastTickAt = block.timestamp;
    }
}
