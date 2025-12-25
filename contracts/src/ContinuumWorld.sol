// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {AgentWallet} from "./AgentWallet.sol";

/// @title ContinuumWorld
/// @notice Public crank for Continuum: advances ticks and asks agents to execute due pulls.
/// @dev This contract is intentionally dumb and non-discretionary.
///      It cannot move funds itself; only AgentWallets (as grantees) can call the executor.
///
/// FIXES:
/// 1) Make tick() safely permissionless by rate-limiting (one tick per block OR minimum seconds).
/// 2) Add a non-reverting tick path (tickSafe) so a single failing agent doesn't brick the world.
/// 3) Keep strict tick() available (reverts if any agent reverts) for testing/debug.
/// 4) Make addAgent idempotent + validate contract code.
contract ContinuumWorld {
    uint32 public tickCount;
    uint256 public startedAt;

    AgentWallet[] public agents;

    // --- Anti-spam / anti-acceleration guards ---
    // If both are set, BOTH must be satisfied.
    uint64 public minTickSeconds; // 0 = disabled
    uint256 public lastTickTimestamp;
    uint256 public lastTickBlock;

    // Optional: prevent duplicate agents
    mapping(address => bool) public isAgent;

    event Started(uint256 timestamp);
    event AgentAdded(address indexed agent);
    event WorldTick(uint32 indexed tick, uint256 timestamp);

    // Emitted only by tickSafe()
    event AgentTickFailed(uint32 indexed tick, address indexed agent, bytes data);

    constructor(uint64 _minTickSeconds) {
        startedAt = block.timestamp;
        lastTickTimestamp = block.timestamp;
        lastTickBlock = block.number;
        minTickSeconds = _minTickSeconds; // e.g. 1..10; set 0 to disable
        emit Started(block.timestamp);
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    /// @notice Update the minimum time between ticks (seconds). Permissionless for v0 demo simplicity.
    /// @dev If you want to harden: gate this to an owner/keeper later.
    function setMinTickSeconds(uint64 secs_) external {
        minTickSeconds = secs_;
    }

    function addAgent(address agent) external {
        require(agent != address(0), "BAD_AGENT");
        require(agent.code.length > 0, "NOT_CONTRACT");
        require(!isAgent[agent], "DUP_AGENT");
        isAgent[agent] = true;
        agents.push(AgentWallet(agent));
        emit AgentAdded(agent);
    }

    // --- Internal guard used by both tick methods ---
    function _enforceTickGuards() internal {
        // Prevent multiple ticks in the same block (stops mass-spam from racing your runner)
        require(block.number > lastTickBlock, "TOO_SOON_BLOCK");

        // Optional: enforce a minimum wall-clock interval between ticks (helps on fast blocks)
        if (minTickSeconds != 0) {
            require(block.timestamp >= lastTickTimestamp + minTickSeconds, "TOO_SOON_TIME");
        }

        lastTickBlock = block.number;
        lastTickTimestamp = block.timestamp;
    }

    /// @notice Advance the world by 1 tick and invoke each agent's tick(currentTick).
    /// @dev STRICT: reverts if any agent reverts. Good for tests.
    function tick() external {
        _enforceTickGuards();

        tickCount += 1;
        uint32 t = tickCount;

        uint256 len = agents.length;
        for (uint256 i = 0; i < len; i++) {
            agents[i].tick(t);
        }

        emit WorldTick(t, block.timestamp);
    }

    /// @notice Advance the world by 1 tick; continues even if some agents revert.
    /// @dev SAFE: logs failures and keeps the simulation alive on public RPCs.
    function tickSafe() external {
        _enforceTickGuards();

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
}
