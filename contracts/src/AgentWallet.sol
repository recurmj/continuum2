// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {LibECDSA} from "./LibECDSA.sol";
import {IERC20Minimal, SafeERC20Minimal} from "./ERC20Minimal.sol";
import {RecurPullSafeV2} from "./RecurPullSafeV2.sol";

/// @title AgentWallet
/// @notice Minimal smart-wallet agent for Continuum.
///         - Acts as a grantee (caller == receiver) for inbound PPO pulls.
///         - Can also act as a grantor (EIP-1271) for authorizations it signs via its owner.
///         - Stores inbound edges and executes due pulls when ticked.
contract AgentWallet {
    using SafeERC20Minimal for IERC20Minimal;

    bytes4 internal constant _MAGIC = 0x1626ba7e;

    address public immutable owner;
    RecurPullSafeV2 public immutable executor;

    event EdgeAdded(uint256 indexed edgeId, bytes32 indexed authHash, address indexed grantor, address token, uint256 amountPerTick, uint32 periodTicks);
    event EdgeExecuted(uint256 indexed edgeId, bytes32 indexed authHash, uint32 tick, uint256 amount);
    event EdgeFailed(uint256 indexed edgeId, bytes32 indexed authHash, uint32 tick, bytes reason);

    struct Edge {
        RecurPullSafeV2.Authorization auth; // includes signature
        uint256 amountPerTick;             // must be <= maxPerPull
        uint32 periodTicks;
        uint32 nextDueTick;
        bool active;
    }

    Edge[] public edges;

    // Optional shock config (single shot)
    bool public shockEnabled;
    uint32 public shockTick;
    uint256 public shockAmount; // intentionally bad (e.g., maxPerPull+1)
    uint256 public shockEdgeId;

    constructor(address _owner, address _executor) {
        require(_owner != address(0), "BAD_OWNER");
        require(_executor != address(0), "BAD_EXECUTOR");
        owner = _owner;
        executor = RecurPullSafeV2(_executor);
    }

    /// @notice EIP-1271 verifier: valid if `owner` signed `digest`.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        // Reuse LibECDSA for strict low-s checks.
        address recovered = LibECDSA.recover(digest, bytes(signature));
        return recovered == owner ? _MAGIC : bytes4(0);
    }

    /// @notice Approve the executor to pull tokens FROM this wallet when it is the grantor.
    function approveToken(address token, uint256 amount) external {
        require(msg.sender == owner, "NOT_OWNER");
        IERC20Minimal(token).safeApprove(address(executor), amount);
    }

    function addEdge(
        RecurPullSafeV2.Authorization calldata auth,
        uint256 amountPerTick,
        uint32 periodTicks,
        uint32 startTick
    ) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(auth.grantee == address(this), "GRANTEE_NOT_SELF");
        require(amountPerTick > 0, "AMOUNT_0");
        require(amountPerTick <= auth.maxPerPull, "AMOUNT_GT_MAX");
        require(periodTicks > 0, "PERIOD_0");

        Edge memory e = Edge({
            auth: auth,
            amountPerTick: amountPerTick,
            periodTicks: periodTicks,
            nextDueTick: startTick,
            active: true
        });
        edges.push(e);

        bytes32 authHash = executor.authHashOf(auth);
        emit EdgeAdded(edges.length - 1, authHash, auth.grantor, auth.token, amountPerTick, periodTicks);
    }

    function setShock(uint256 edgeId, uint32 _shockTick, uint256 _shockAmount) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(edgeId < edges.length, "BAD_EDGE");
        shockEnabled = true;
        shockEdgeId = edgeId;
        shockTick = _shockTick;
        shockAmount = _shockAmount;
    }

    /// @notice Called by ContinuumWorld (or anyone). Executes all due edges at `currentTick`.
    function tick(uint32 currentTick) external {
        // Shock attempt first (so it's visible even if regular pulls succeed).
        if (shockEnabled && currentTick == shockTick) {
            _attemptEdge(shockEdgeId, currentTick, shockAmount);
        }

        uint256 len = edges.length;
        for (uint256 i = 0; i < len; i++) {
            Edge storage e = edges[i];
            if (!e.active) continue;
            if (currentTick < e.nextDueTick) continue;

            // Execute once per tick for v0.
            _attemptEdge(i, currentTick, e.amountPerTick);

            // Schedule next due tick.
            unchecked {
                e.nextDueTick = currentTick + e.periodTicks;
            }
        }
    }

    function _attemptEdge(uint256 edgeId, uint32 currentTick, uint256 amount) internal {
        Edge storage e = edges[edgeId];
        bytes32 authHash = executor.authHashOf(e.auth);

        try executor.pull(e.auth, amount) {
            emit EdgeExecuted(edgeId, authHash, currentTick, amount);
        } catch (bytes memory reason) {
            emit EdgeFailed(edgeId, authHash, currentTick, reason);
        }
    }
}
