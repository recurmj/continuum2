import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { startApiServer, updateState } from "./api.js";

/**
 * Continuum Runner (EVM-real)
 * - Deploys RecurConsentRegistry + RecurPullSafeV2 + MockUSD + ContinuumWorld + AgentWallets
 * - Seeds balances ONCE (pushes)
 * - Installs PPO edges (EIP-712 digest signed by grantor AgentWallet owner EOA; validated via EIP-1271)
 * - Runs the public crank (ContinuumWorld.tick()) on an interval
 * - Exposes /state + dashboard via a tiny HTTP server (api.js)
 *
 * FIXES INCLUDED (critical):
 * 1) Prevent overlapping tick() txs (mutex) -> avoids nonce spam, replacement-underpriced, NONCE_EXPIRED
 * 2) Preflight tick via staticCall to capture revert reason BEFORE sending a tx
 * 3) Explicit nonce manager + pending nonce awareness
 * 4) Backoff on errors + treat "replacement underpriced" as non-fatal (skip)
 * 5) Persist lastBlock/errorCount periodically + on shutdown
 */

// ----------------------------- Config ----------------------------------------
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const MNEMONIC =
  process.env.MNEMONIC ??
  "test test test test test test test test test test test junk";

const TICK_MS = Number(process.env.TICK_MS ?? "1000");
const API_PORT = Number(process.env.PORT ?? "8787");
const STATE_FILE = process.env.STATE_FILE ?? "./state.json";
const RESUME = (process.env.RESUME ?? "1") !== "0";

// Defaults (frozen unless you override env vars)
const WORKERS = Number(process.env.WORKERS ?? "10");
const MERCHANTS = Number(process.env.MERCHANTS ?? "3");
const SUBS = Number(process.env.SUBS ?? "2");

// Optional: raise gas limit for heavy ticks on public RPCs
const TICK_GAS_LIMIT = process.env.TICK_GAS_LIMIT ? BigInt(process.env.TICK_GAS_LIMIT) : null;
// Optional: allow skipping revert-ticks instead of spamming chain
const SKIP_ON_PREFLIGHT_REVERT = (process.env.SKIP_ON_PREFLIGHT_REVERT ?? "1") !== "0";

// -------------------------- Foundry artifacts --------------------------------
function loadArtifact(solName, contractName = solName) {
  // Foundry output: contracts/out/<SolName>.sol/<ContractName>.json
  const p = path.join("..", "contracts", "out", `${solName}.sol`, `${contractName}.json`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const bytecode = j.bytecode?.object ?? j.bytecode;
  return { abi: j.abi, bytecode };
}

/**
 * IMPORTANT FIX:
 * - Force deterministic derivation path for ALL wallets.
 * - This prevents the deployer/signer from "changing" across runs/sessions.
 * - Always uses m/44'/60'/0'/0/<index>
 */
function walletAt(index, provider) {
  return ethers.HDNodeWallet
    .fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`)
    .connect(provider);
}

function randBytes32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function abiEncode(types, values) {
  return ethers.AbiCoder.defaultAbiCoder().encode(types, values);
}

function keccak(data) {
  return ethers.keccak256(data);
}

function concat(...parts) {
  return ethers.concat(parts);
}

// Decode a revert string where possible (Error(string))
function decodeRevertReason(dataHex) {
  try {
    if (!dataHex || dataHex === "0x") return "";
    const ERROR_SIG = "0x08c379a0"; // Error(string)
    if (dataHex.startsWith(ERROR_SIG)) {
      const encoded = "0x" + dataHex.slice(10);
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], encoded);
      return String(reason);
    }
    return "";
  } catch {
    return "";
  }
}

// Best-effort decode of ethers v6 errors -> { reason, data }
function extractEthersRevert(e) {
  const out = { reason: "", data: "" };
  try {
    // Common shapes:
    // e.data, e.error?.data, e.info?.error?.data, e.receipt?.revertReason (rare)
    const data =
      e?.data ??
      e?.error?.data ??
      e?.info?.error?.data ??
      e?.info?.data ??
      "";
    if (typeof data === "string") out.data = data;

    // Many providers put "reason" on shortMessage or error.message
    const msg = String(e?.shortMessage ?? e?.reason ?? e?.message ?? "");
    out.reason = msg;

    // If we have Error(string) payload, decode it (often much clearer than msg)
    const decoded = decodeRevertReason(out.data);
    if (decoded) out.reason = decoded;

    return out;
  } catch {
    return out;
  }
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  // Deployer/controller (also registry controller)
  const deployer = walletAt(0, provider);

  console.log("RPC:", RPC);
  console.log("chainId:", chainId);
  console.log("DEPLOYER (fund this):", await deployer.getAddress());

  // Owner EOAs for agent wallets:
  // [1] treasury, [2] employer, then merchants, subs, workers.
  const ownerTreasury = walletAt(1, provider);
  const ownerEmployer = walletAt(2, provider);

  const ownerMerchants = Array.from({ length: MERCHANTS }, (_, i) => walletAt(3 + i, provider));
  const ownerSubs = Array.from({ length: SUBS }, (_, i) => walletAt(3 + MERCHANTS + i, provider));
  const ownerWorkers = Array.from({ length: WORKERS }, (_, i) => walletAt(3 + MERCHANTS + SUBS + i, provider));

  // Load artifacts
  const MockUSD = loadArtifact("MockUSD");
  const RecurConsentRegistry = loadArtifact("RecurConsentRegistry");
  const RecurPullSafeV2 = loadArtifact("RecurPullSafeV2");
  const AgentWallet = loadArtifact("AgentWallet");
  const ContinuumWorld = loadArtifact("ContinuumWorld");

  // -------------------------------------------------------------------------
  // Deploy OR resume existing deployment
  // -------------------------------------------------------------------------
  const prior = RESUME ? readJsonIfExists(STATE_FILE) : null;

  const canResume = async () => {
    try {
      if (!prior || !prior.addresses) return false;
      if (Number(prior.chainId ?? 0) !== chainId) return false;
      const addrs = prior.addresses;
      const required = [addrs.token, addrs.registry, addrs.pullSafe, addrs.world];
      if (required.some((a) => !a || a === ethers.ZeroAddress)) return false;
      const codes = await Promise.all(required.map((a) => provider.getCode(a)));
      return codes.every((c) => c && c !== "0x");
    } catch {
      return false;
    }
  };

  const doResume = prior && (await canResume());

  let token, registry, pullSafe, world;
  if (doResume) {
    console.log(`Resuming from ${STATE_FILE} (chainId=${chainId})`);
    token = new ethers.Contract(prior.addresses.token, MockUSD.abi, deployer);
    registry = new ethers.Contract(prior.addresses.registry, RecurConsentRegistry.abi, deployer);
    pullSafe = new ethers.Contract(prior.addresses.pullSafe, RecurPullSafeV2.abi, deployer);
    world = new ethers.Contract(prior.addresses.world, ContinuumWorld.abi, deployer);
  } else {
    if (RESUME) console.log(`No valid resume state found at ${STATE_FILE}. Deploying fresh.`);

    token = await new ethers.ContractFactory(MockUSD.abi, MockUSD.bytecode, deployer).deploy();
    await token.waitForDeployment();

    registry = await new ethers.ContractFactory(
      RecurConsentRegistry.abi,
      RecurConsentRegistry.bytecode,
      deployer
    ).deploy(await deployer.getAddress());
    await registry.waitForDeployment();

    pullSafe = await new ethers.ContractFactory(
      RecurPullSafeV2.abi,
      RecurPullSafeV2.bytecode,
      deployer
    ).deploy(await registry.getAddress());
    await pullSafe.waitForDeployment();

    world = await new ethers.ContractFactory(
      ContinuumWorld.abi,
      ContinuumWorld.bytecode,
      deployer
    ).deploy();
    await world.waitForDeployment();

    // Trust PullSafe as executor in registry
    await (await registry.setTrustedExecutor(await pullSafe.getAddress(), true)).wait();
  }

  // Deploy OR attach agent wallets
  async function deployAgent(label, ownerWallet) {
    const agent = await new ethers.ContractFactory(AgentWallet.abi, AgentWallet.bytecode, deployer).deploy(
      await ownerWallet.getAddress(),
      await pullSafe.getAddress()
    );
    await agent.waitForDeployment();
    const addr = await agent.getAddress();
    await (await world.addAgent(addr)).wait();
    return { label, owner: ownerWallet, addr, contract: new ethers.Contract(addr, AgentWallet.abi, provider) };
  }

  function attachAgent(label, ownerWallet, addr) {
    return { label, owner: ownerWallet, addr, contract: new ethers.Contract(addr, AgentWallet.abi, provider) };
  }

  let treasury, employer, merchants, subs, workers;
  if (doResume) {
    const a = prior.addresses.agents;
    treasury = attachAgent("treasury", ownerTreasury, a.treasury);
    employer = attachAgent("employer", ownerEmployer, a.employer);
    merchants = a.merchants.map((addr, i) => attachAgent(`merchant${i + 1}`, ownerMerchants[i], addr));
    subs = a.subs.map((addr, i) => attachAgent(`sub${i + 1}`, ownerSubs[i], addr));
    workers = a.workers.map((addr, i) => attachAgent(`worker${i + 1}`, ownerWorkers[i], addr));
  } else {
    treasury = await deployAgent("treasury", ownerTreasury);
    employer = await deployAgent("employer", ownerEmployer);
    merchants = [];
    for (let i = 0; i < MERCHANTS; i++) merchants.push(await deployAgent(`merchant${i + 1}`, ownerMerchants[i]));
    subs = [];
    for (let i = 0; i < SUBS; i++) subs.push(await deployAgent(`sub${i + 1}`, ownerSubs[i]));
    workers = [];
    for (let i = 0; i < WORKERS; i++) workers.push(await deployAgent(`worker${i + 1}`, ownerWorkers[i]));

    // One-time seeding (pushes)
    const ONE = 10n ** 18n;
    await (await token.mint(employer.addr, 5_000_000n * ONE)).wait();
    await (await token.mint(treasury.addr, 1_000_000n * ONE)).wait();
  }

  const ONE = 10n ** 18n;

  // Each grantor agent must approve PullSafe to spend token
  async function approveFromAgent(agent, allowance) {
    await (await agent.contract.connect(agent.owner).approveToken(await token.getAddress(), allowance)).wait();
  }

  if (!doResume) {
    const bigAllowance = ethers.MaxUint256;
    await approveFromAgent(employer, bigAllowance);
    await approveFromAgent(treasury, bigAllowance);
    for (const w of workers) await approveFromAgent(w, bigAllowance);
    for (const m of merchants) await approveFromAgent(m, bigAllowance);
    for (const s of subs) await approveFromAgent(s, bigAllowance);
  }

  // PPO signing using executor domainSeparator() (avoids reconstructed domain footguns)
  const domainSep = await pullSafe.domainSeparator();
  const AUTH_TYPEHASH = keccak(
    ethers.toUtf8Bytes(
      "Authorization(address grantor,address grantee,address token,uint256 maxPerPull,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    )
  );

  function structHashFor(authFields) {
    return keccak(
      abiEncode(
        ["bytes32", "address", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [
          AUTH_TYPEHASH,
          authFields.grantor,
          authFields.grantee,
          authFields.token,
          authFields.maxPerPull,
          authFields.validAfter,
          authFields.validBefore,
          authFields.nonce,
        ]
      )
    );
  }

  function digestFor(structHash) {
    return keccak(concat("0x1901", domainSep, structHash));
  }

  async function signPPO({ grantorAgent, granteeAddr, maxPerPull, validAfter, validBefore, nonce }) {
    const fields = {
      grantor: grantorAgent.addr,
      grantee: granteeAddr,
      token: await token.getAddress(),
      maxPerPull,
      validAfter,
      validBefore,
      nonce,
    };
    const sh = structHashFor(fields);
    const digest = digestFor(sh);

    // Sign digest directly (EOA signs; AgentWallet validates via EIP-1271)
    const sig = grantorAgent.owner.signingKey.sign(digest).serialized;
    return { fields, sig };
  }

  async function addEdgeToGrantee({ granteeAgent, authFields, sig, amountPerTick, periodTicks, startTick }) {
    const auth = {
      grantor: authFields.grantor,
      grantee: authFields.grantee,
      token: authFields.token,
      maxPerPull: authFields.maxPerPull,
      validAfter: authFields.validAfter,
      validBefore: authFields.validBefore,
      nonce: authFields.nonce,
      signature: sig,
    };
    await (await granteeAgent.contract.connect(granteeAgent.owner).addEdge(auth, amountPerTick, periodTicks, startTick)).wait();
  }

  if (!doResume) {
    // Define the world edges (closed loop)
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = now - 60n;
    const validBefore = now + 365n * 24n * 3600n;

    // Salary: each worker pulls from employer every tick
    const salary = 1_000n * ONE;
    for (const w of workers) {
      const nonce = randBytes32();
      const { fields, sig } = await signPPO({
        grantorAgent: employer,
        granteeAddr: w.addr,
        maxPerPull: salary,
        validAfter,
        validBefore,
        nonce,
      });
      await addEdgeToGrantee({
        granteeAgent: w,
        authFields: fields,
        sig,
        amountPerTick: salary,
        periodTicks: 1,
        startTick: 1,
      });
    }

    // Spending: each merchant pulls from each worker every tick (smaller)
    const spend = 120n * ONE;
    for (const m of merchants) {
      for (const w of workers) {
        const nonce = randBytes32();
        const { fields, sig } = await signPPO({
          grantorAgent: w,
          granteeAddr: m.addr,
          maxPerPull: spend,
          validAfter,
          validBefore,
          nonce,
        });
        await addEdgeToGrantee({
          granteeAgent: m,
          authFields: fields,
          sig,
          amountPerTick: spend,
          periodTicks: 1,
          startTick: 1,
        });
      }
    }

    // Subscriptions: each subscription pulls from each worker every 2 ticks
    const subPay = 50n * ONE;
    for (const s of subs) {
      for (const w of workers) {
        const nonce = randBytes32();
        const { fields, sig } = await signPPO({
          grantorAgent: w,
          granteeAddr: s.addr,
          maxPerPull: subPay,
          validAfter,
          validBefore,
          nonce,
        });
        await addEdgeToGrantee({
          granteeAgent: s,
          authFields: fields,
          sig,
          amountPerTick: subPay,
          periodTicks: 2,
          startTick: 2,
        });
      }
    }

    // Merchant remit: treasury pulls from each merchant every tick
    const remit = BigInt(WORKERS) * spend;
    for (const m of merchants) {
      const nonce = randBytes32();
      const { fields, sig } = await signPPO({
        grantorAgent: m,
        granteeAddr: treasury.addr,
        maxPerPull: remit,
        validAfter,
        validBefore,
        nonce,
      });
      await addEdgeToGrantee({
        granteeAgent: treasury,
        authFields: fields,
        sig,
        amountPerTick: remit,
        periodTicks: 1,
        startTick: 1,
      });
    }

    // Treasury drip: employer pulls from treasury every tick
    const drip = BigInt(WORKERS) * salary;
    {
      const nonce = randBytes32();
      const { fields, sig } = await signPPO({
        grantorAgent: treasury,
        granteeAddr: employer.addr,
        maxPerPull: drip,
        validAfter,
        validBefore,
        nonce,
      });
      await addEdgeToGrantee({
        granteeAgent: employer,
        authFields: fields,
        sig,
        amountPerTick: drip,
        periodTicks: 1,
        startTick: 1,
      });
    }

    // Shock: first merchant edge (edgeId=0) over-cap at tick 5
    await (await merchants[0].contract.connect(merchants[0].owner).setShock(0, 5, spend + 1n)).wait();
  }

  // -------------------------- API + State ------------------------------------
  const addresses = {
    token: await token.getAddress(),
    registry: await registry.getAddress(),
    pullSafe: await pullSafe.getAddress(),
    world: await world.getAddress(),
    agents: {
      treasury: treasury.addr,
      employer: employer.addr,
      workers: workers.map((w) => w.addr),
      merchants: merchants.map((m) => m.addr),
      subs: subs.map((s) => s.addr),
    },
  };

  const abis = {
    PullSafe: RecurPullSafeV2.abi,
    Registry: RecurConsentRegistry.abi,
    AgentWallet: AgentWallet.abi,
    World: ContinuumWorld.abi,
  };

  startApiServer({ port: API_PORT, addresses, abis });

  const deploymentState = {
    version: 1,
    chainId,
    rpc: RPC,
    createdAt: prior?.createdAt ?? new Date().toISOString(),
    addresses,
    lastBlock: prior?.lastBlock ?? null,
  };
  writeJsonAtomic(STATE_FILE, deploymentState);

  console.log("\nContinuum is live:");
  console.log(`- Dashboard: http://127.0.0.1:${API_PORT}`);
  console.log(`- State:     http://127.0.0.1:${API_PORT}/state`);
  console.log(`- Tick:      every ${TICK_MS} ms`);
  console.log("");

  // IMPORTANT: use NonceManager to avoid stale local nonce assumptions
  const managedDeployer = new ethers.NonceManager(deployer);
  const worldConn = new ethers.Contract(addresses.world, ContinuumWorld.abi, managedDeployer);
  const tokenConn = new ethers.Contract(addresses.token, MockUSD.abi, provider);

  // Log polling
  let lastBlock = (doResume && prior?.lastBlock != null)
    ? Number(prior.lastBlock)
    : await provider.getBlockNumber();

  const ifacePullSafe = new ethers.Interface(RecurPullSafeV2.abi);
  const ifaceRegistry = new ethers.Interface(RecurConsentRegistry.abi);
  const ifaceAgent = new ethers.Interface(AgentWallet.abi);

  // Addresses to watch
  const watchAddrs = [
    addresses.pullSafe,
    addresses.registry,
    ...workers.map((w) => w.addr),
    ...merchants.map((m) => m.addr),
    ...subs.map((s) => s.addr),
    treasury.addr,
    employer.addr,
  ];

  function normalizeEvent(ev) {
    const base = {
      address: ev.address,
      blockNumber: ev.blockNumber,
      tx: ev.transactionHash,
      type: ev.name,
    };
    const a = ev.args ?? [];
    if (ev.name === "PullExecutedDirect") {
      return {
        ...base,
        authHash: a[0],
        token: a[1],
        grantor: a[2],
        grantee: a[3],
        amount: a[4].toString(),
      };
    }
    if (ev.name === "PullExecuted") {
      return {
        ...base,
        authHash: a[0],
        token: a[1],
        grantor: a[2],
        grantee: a[3],
        amount: a[4].toString(),
        cumulative: a[5].toString(),
      };
    }
    if (ev.name === "AuthorizationRevoked") {
      return { ...base, authHash: a[0], grantor: a[1], timestamp: a[2].toString() };
    }
    if (ev.name === "EdgeExecuted") {
      return { ...base, edgeId: Number(a[0]), authHash: a[1], amount: a[2].toString() };
    }
    if (ev.name === "EdgeFailed") {
      return { ...base, edgeId: Number(a[0]), authHash: a[1], amount: a[2].toString(), reason: decodeRevertReason(a[3]) };
    }
    return { ...base, args: a.map((x) => (typeof x === "bigint" ? x.toString() : x)) };
  }

  async function snapshot(tickCount) {
    const bal = async (addr) => (await tokenConn.balanceOf(addr)).toString();

    const state = {
      tickCount: Number(tickCount),
      tickMs: TICK_MS,
      startedAt: Number(await worldConn.startedAt()),
      agents: {
        treasury: { address: treasury.addr, balance: await bal(treasury.addr) },
        employer: { address: employer.addr, balance: await bal(employer.addr) },
        workers: await Promise.all(workers.map(async (w) => ({ address: w.addr, balance: await bal(w.addr) }))),
        merchants: await Promise.all(merchants.map(async (m) => ({ address: m.addr, balance: await bal(m.addr) }))),
        subs: await Promise.all(subs.map(async (s) => ({ address: s.addr, balance: await bal(s.addr) }))),
      },
      shock: { tick: 5, contained: null, armed: true },
    };
    updateState(state);
  }

  let errorCount = Number(prior?.errorCount ?? 0);

  function persistRuntime() {
    try {
      writeJsonAtomic(STATE_FILE, {
        ...deploymentState,
        lastBlock,
        errorCount,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore persistence errors
    }
  }

  setInterval(persistRuntime, 60_000).unref?.();

  const onShutdown = () => {
    try { persistRuntime(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  await snapshot(await worldConn.tickCount());
  updateState({ lastTickAt: Date.now(), errorCount });
  persistRuntime();

  // -------------------------- Tick loop (FIXED) ------------------------------
  let ticking = false;
  let backoffMs = 0;

  setInterval(async () => {
    if (ticking) return;
    if (backoffMs > 0) return;

    ticking = true;
    try {
      // Preflight: if this reverts, you get revert data (and we avoid wasting gas + nonce spam)
      try {
        await worldConn.tick.staticCall();
      } catch (e) {
        const { reason, data } = extractEthersRevert(e);
        errorCount += 1;
        updateState({ errorCount, lastTickAt: Date.now(), lastTickError: { reason, data } });
        persistRuntime();

        if (SKIP_ON_PREFLIGHT_REVERT) {
          console.error("tick preflight reverted:", reason || e);
          return;
        }
        // If you want to force-send anyway, fall through (not recommended)
      }

      // Send the real tx
      const overrides = {};
      if (TICK_GAS_LIMIT != null) overrides.gasLimit = TICK_GAS_LIMIT;

      const tx = await worldConn.tick(overrides);
      const rcpt = await tx.wait();

      updateState({ lastTickAt: Date.now(), lastTickError: null });

      const tickCount = await worldConn.tickCount();

      // Pull new logs since lastBlock
      const currentBlock = rcpt.blockNumber;
      const fromBlock = lastBlock + 1;
      const toBlock = currentBlock;

      if (toBlock >= fromBlock) {
        const logs = await provider.getLogs({
          fromBlock,
          toBlock,
          address: watchAddrs,
        });

        const recent = [];
        for (const l of logs) {
          try {
            if (l.address.toLowerCase() === addresses.pullSafe.toLowerCase()) {
              const ev = ifacePullSafe.parseLog(l);
              recent.push(normalizeEvent({ ...ev, address: l.address, blockNumber: l.blockNumber, transactionHash: l.transactionHash }));
            } else if (l.address.toLowerCase() === addresses.registry.toLowerCase()) {
              const ev = ifaceRegistry.parseLog(l);
              recent.push(normalizeEvent({ ...ev, address: l.address, blockNumber: l.blockNumber, transactionHash: l.transactionHash }));
            } else {
              const ev = ifaceAgent.parseLog(l);
              recent.push(normalizeEvent({ ...ev, address: l.address, blockNumber: l.blockNumber, transactionHash: l.transactionHash }));
            }
          } catch {
            // ignore non-matching logs
          }
        }
        updateState({ recentEvents: recent });
      }

      lastBlock = currentBlock;
      persistRuntime();

      if (Number(tickCount) % 3 === 0) {
        await snapshot(tickCount);
      } else {
        updateState({ tickCount: Number(tickCount) });
      }

      if (Number(tickCount) % 10 === 0) {
        const bEmp = await tokenConn.balanceOf(employer.addr);
        const bTre = await tokenConn.balanceOf(treasury.addr);
        console.log(`tick=${tickCount} employer=${ethers.formatUnits(bEmp, 18)} treasury=${ethers.formatUnits(bTre, 18)}`);
      }
    } catch (e) {
      // Handle common mempool issues gracefully (don’t escalate into nonce chaos)
      const msg = String(e?.shortMessage ?? e?.message ?? "");
      if (msg.includes("replacement transaction underpriced") || msg.includes("replacement fee too low")) {
        console.error("tick mempool warning:", msg);
        // short backoff to let mempool settle
        backoffMs = Math.max(backoffMs, 1500);
        setTimeout(() => { backoffMs = 0; }, backoffMs).unref?.();
        return;
      }

      if (msg.includes("nonce too low") || msg.includes("nonce has already been used") || msg.includes("NONCE_EXPIRED")) {
        console.error("tick nonce warning:", msg);
        // reset managed nonce to pending nonce
        try {
          const pending = await provider.getTransactionCount(await deployer.getAddress(), "pending");
          managedDeployer.setNonce(pending);
        } catch {}
        backoffMs = Math.max(backoffMs, 2000);
        setTimeout(() => { backoffMs = 0; }, backoffMs).unref?.();
        return;
      }

      const { reason, data } = extractEthersRevert(e);
      errorCount += 1;
      updateState({ errorCount, lastTickAt: Date.now(), lastTickError: { reason, data } });
      persistRuntime();
      console.error("tick error:", reason || e);

      // Exponential-ish backoff on unknown errors (protects public RPC)
      backoffMs = Math.min(30_000, Math.max(1500, (backoffMs || 1500) * 2));
      setTimeout(() => { backoffMs = 0; }, backoffMs).unref?.();
    } finally {
      ticking = false;
    }
  }, TICK_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
