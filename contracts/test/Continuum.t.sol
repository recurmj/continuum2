// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

import {MockUSD} from "../src/MockUSD.sol";
import {RecurConsentRegistry} from "../src/RecurConsentRegistry.sol";
import {RecurPullSafeV2} from "../src/RecurPullSafeV2.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {ContinuumWorld} from "../src/ContinuumWorld.sol";

contract ContinuumTest is Test {
    MockUSD token;
    RecurConsentRegistry registry;
    RecurPullSafeV2 executor;
    ContinuumWorld world;

    uint256 ownerPkA = 0xA11CE;
    uint256 ownerPkB = 0xB0B;
    address ownerA;
    address ownerB;

    AgentWallet employer; // grantor for payroll
    AgentWallet worker;   // grantee for payroll

    function setUp() public {
        ownerA = vm.addr(ownerPkA);
        ownerB = vm.addr(ownerPkB);

        token = new MockUSD("MockUSD", "mUSD", 18);
        registry = new RecurConsentRegistry(address(this));
        executor = new RecurPullSafeV2(address(registry));
        // trust the executor in the registry
        registry.setTrustedExecutor(address(executor), true);

        world = new ContinuumWorld();

        // Create two agents
        employer = new AgentWallet(ownerA, address(executor));
        worker   = new AgentWallet(ownerB, address(executor));

        // Add agents to world
        world.addAgent(address(employer));
        world.addAgent(address(worker));

        // Seed balances
        token.mint(address(employer), 1_000_000 ether);

        // employer approves executor to pull mUSD from employer when employer is grantor
        vm.prank(ownerA);
        employer.approveToken(address(token), type(uint256).max);
    }

    function _signAuth(address signingOwner, uint256 signingPk, RecurPullSafeV2.Authorization memory auth)
        internal
        view
        returns (bytes memory sig)
    {
        // Compute structHash per RecurPullSafeV2:
        bytes32 AUTH_TYPEHASH = keccak256(
            "Authorization(address grantor,address grantee,address token,uint256 maxPerPull,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

        bytes32 structHash = keccak256(
            abi.encode(
                AUTH_TYPEHASH,
                auth.grantor,
                auth.grantee,
                auth.token,
                auth.maxPerPull,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );

        bytes32 domainSep = executor.domainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingPk, digest);
        sig = abi.encodePacked(r, s, v);
        // sanity: recovered should be signer
        address recovered = ecrecover(digest, v, r, s);
        require(recovered == signingOwner, "SIG_RECOVER_MISMATCH");
    }

    function testPayrollEdgeRunsAndBindsOwner() public {
        // Build payroll authorization: employer -> worker, worker is grantee/receiver.
        RecurPullSafeV2.Authorization memory auth;
        auth.grantor = address(employer);
        auth.grantee = address(worker);
        auth.token = address(token);
        auth.maxPerPull = 10 ether;
        auth.validAfter = block.timestamp;
        auth.validBefore = block.timestamp + 7 days;
        auth.nonce = keccak256("payroll-1");

        // Sign by employer ownerA (because employer is contract wallet; 1271 checks owner signature)
        bytes memory sig = _signAuth(ownerA, ownerPkA, auth);
        auth.signature = sig;

        // Worker stores inbound edge
        vm.prank(ownerB);
        worker.addEdge(auth, 5 ether, 1, 1); // every tick, starting tick 1

        // Tick world 3 times
        world.tick(); // t=1 executes payroll
        world.tick(); // t=2 executes payroll
        world.tick(); // t=3 executes payroll

        // Worker should have received 15 ether total
        assertEq(token.balanceOf(address(worker)), 15 ether);

        // Registry should have bound ownerOfAuth to employer after first pull
        bytes32 authHash = executor.authHashOf(auth);
        assertEq(registry.ownerOfAuth(authHash), address(employer));
        assertEq(registry.totalPulled(authHash), 15 ether);
    }

    function testShockOverCapIsContained() public {
        // Payroll auth with max 10, normal amount 5.
        RecurPullSafeV2.Authorization memory auth;
        auth.grantor = address(employer);
        auth.grantee = address(worker);
        auth.token = address(token);
        auth.maxPerPull = 10 ether;
        auth.validAfter = block.timestamp;
        auth.validBefore = block.timestamp + 7 days;
        auth.nonce = keccak256("payroll-2");

        auth.signature = _signAuth(ownerA, ownerPkA, auth);

        vm.prank(ownerB);
        worker.addEdge(auth, 5 ether, 1, 1);

        // Configure shock: at tick 2, attempt amount 11 > maxPerPull
        vm.prank(ownerB);
        worker.setShock(0, 2, 11 ether);

        world.tick(); // t=1 normal pull succeeds
        world.tick(); // t=2 shock attempt fails, then normal pull also runs (still succeeds)

        // Total should be 10 (two normal pulls), shock did not transfer.
        assertEq(token.balanceOf(address(worker)), 10 ether);
    }

    function testRevocationStopsFuturePulls() public {
        RecurPullSafeV2.Authorization memory auth;
        auth.grantor = address(employer);
        auth.grantee = address(worker);
        auth.token = address(token);
        auth.maxPerPull = 10 ether;
        auth.validAfter = block.timestamp;
        auth.validBefore = block.timestamp + 7 days;
        auth.nonce = keccak256("payroll-3");
        auth.signature = _signAuth(ownerA, ownerPkA, auth);

        vm.prank(ownerB);
        worker.addEdge(auth, 5 ether, 1, 1);

        world.tick(); // t=1 success
        bytes32 authHash = executor.authHashOf(auth);

        // Revoke from the bound owner (employer address) - but revoke requires msg.sender==ownerOfAuth[authHash].
        // ownerOfAuth binds to grantor address (employer contract) on first pull, so we call from employer.
        // In a real wallet this would be via the employer's owner. For the test, we prank as employer.
        vm.prank(address(employer));
        registry.revoke(authHash);

        world.tick(); // t=2 should fail (REVOKED)
        // Balance remains 5
        assertEq(token.balanceOf(address(worker)), 5 ether);
    }
}
