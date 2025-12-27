import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { startApiServer, updateState } from "./api.js";

/**
 * Continuum Runner (EVM-real)
 *
 * Fixes:
 * 1) ContinuumWorld constructor support:
 *    - New World contract takes constructor(uint64 _minTickSeconds).
 *    - We auto-detect constructor inputs from artifact ABI and pass WORLD_MIN_TICK_SECONDS if required.
 *
 * 2) tickSafe detection:
 *    - Do NOT "probe" tickSafe by calling it (it can revert for reasons unrelated to existence).
 *    - Detect by ABI presence: world.interface.getFunction("tickSafe") in try/catch.
 *
 * 3) Use tickSafe() when available (best-effort world tick), else tick().
 *
 * 4) Keep robust nonce strategy (resync from pending, never go backwards).
 *
 * 5) Make port collisions fatal and obvious.
 */

// ----------------------------- Config ----------------------------------------
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const MNEMONIC =
  process.env.MNEMONIC ??
  "test test test test test test test test test test test junk";

const auths = new Map(); // authHash -> {authHash, grantor, grantee, validAfter, validBefore, revoked}
const TICK_MS = Number(process.env.TICK_MS ?? "1000");
const API_PORT = Number(process.env.PORT ?? "8787");
const STATE_FILE = process.env.STATE_FILE ?? "./state.json";
const RESUME = (process.env.RESUME ?? "1") !== "0";

const DEPLOYER_INDEX = Number(process.env.DEPLOYER_INDEX ?? "0");

// IMPORTANT: your ContinuumWorld now has constructor(uint64 _minTickSeconds)
const WORLD_MIN_TICK_SECONDS = BigInt(process.env.WORLD_MIN_TICK_SECONDS ?? "0");

const WORKERS = Number(process.env.WORKERS ?? "10");
const MERCHANTS = Number(process.env.MERCHANTS ?? "3");
const SUBS = Number(process.env.SUBS ?? "2");

const TICK_GAS_LIMIT = process.env.TICK_GAS_LIMIT ? BigInt(process.env.TICK_GAS_LIMIT) : null;
const SKIP_ON_PREFLIGHT_REVERT = (process.env.SKIP_ON_PREFLIGHT_REVERT ?? "1") !== "0";

const TICK_SEND_RETRIES = Number(process.env.TICK_SEND_RETRIES ?? "6");
const RETRY_SLEEP_MS = Number(process.env.RETRY_SLEEP_MS ?? "800");

// -------------------------- Process guards -----------------------------------
function isAddrInUseError(e) {
  const msg = String(e?.message ?? e ?? "");
  return (
    e?.code === "EADDRINUSE" ||
    msg.includes("EADDRINUSE") ||
    msg.includes("address already in use")
  );
}

process.on("uncaughtException", (e) => {
  if (isAddrInUseError(e)) {
    console.error("\n[FATAL] API port already in use. Pick a different PORT or kill the other runner.");
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
  throw e;
});

process.on("unhandledRejection", (e) => {
  if (isAddrInUseError(e)) {
    console.error("\n[FATAL] API port already in use. Pick a different PORT or kill the other runner.");
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
  // let Node print stack
});

// -------------------------- Foundry artifacts --------------------------------
function loadArtifact(solName, contractName = solName) {
  const p = path.join("..", "contracts", "out", `${solName}.sol`, `${contractName}.json`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const bytecode = j.bytecode?.object ?? j.bytecode;
  return { abi: j.abi, bytecode };
}

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

// Best-effort decode of ethers v6 errors -> { reason, data, msg }
function extractEthersRevert(e) {
  const out = { reason: "", data: "", msg: "" };
  try {
    const data =
      e?.data ??
      e?.error?.data ??
      e?.info?.error?.data ??
      e?.info?.data ??
      "";
    if (typeof data === "string") out.data = data;

    const msg = String(e?.shortMessage ?? e?.reason ?? e?.message ?? "");
    out.msg = msg;
    out.reason = msg;

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

function isNonceUsedish(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("nonce has already been used") ||
    m.includes("nonce too low") ||
    m.includes("nonce expired") ||
    m.includes("nonce_expired") ||
    (m.includes("nonce") && m.includes("used")) ||
    (m.includes("nonce") && m.includes("low"))
  );
}

function isMempoolFeeish(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("replacement transaction underpriced") ||
    m.includes("replacement fee too low") ||
    m.includes("fee too low") ||
    m.includes("underpriced") ||
    m.includes("could not coalesce error")
  );
}

// Helper: detect ContinuumWorld constructor args from ABI and deploy accordingly
async function deployWorld(ContinuumWorldArtifact, deployer) {
  const f = new ethers.ContractFactory(
    ContinuumWorldArtifact.abi,
    ContinuumWorldArtifact.bytecode,
    deployer
  );

  const inputs = (ContinuumWorldArtifact.abi || []).find((x) => x.type === "constructor")?.inputs ?? [];
  if (inputs.length === 0) {
    return f.deploy();
  }
  if (inputs.length === 1 && String(inputs[0].type) === "uint64") {
    console.log("ContinuumWorld constructor(uint64) using WORLD_MIN_TICK_SECONDS:", WORLD_MIN_TICK_SECONDS.toString());
    return f.deploy(WORLD_MIN_TICK_SECONDS);
  }
  throw new Error(
    `Unsupported ContinuumWorld constructor signature. Inputs: ${inputs.map((i) => i.type).join(",")}`
  );
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  const deployer = walletAt(DEPLOYER_INDEX, provider);
  const deployerAddr = await deployer.getAddress();

  console.log("RPC:", RPC);
  console.log("chainId:", chainId);
  console.log("DEPLOYER_INDEX:", DEPLOYER_INDEX);
  console.log("DEPLOYER (fund this):", deployerAddr);

  const ownerTreasury = walletAt(1, provider);
  const ownerEmployer = walletAt(2, provider);

  const ownerMerchants = Array.from({ length: MERCHANTS }, (_, i) => walletAt(3 + i, provider));
  const ownerSubs = Array.from({ length: SUBS }, (_, i) => walletAt(3 + MERCHANTS + i, provider));
  const ownerWorkers = Array.from({ length: WORKERS }, (_, i) =>
    walletAt(3 + MERCHANTS + SUBS + i, provider)
  );

  const MockUSD = loadArtifact("MockUSD");
  const RecurConsentRegistry = loadArtifact("RecurConsentRegistry");
  const RecurPullSafeV2 = loadArtifact("RecurPullSafeV2");
  const AgentWallet = loadArtifact("AgentWallet");
  const ContinuumWorld = loadArtifact("ContinuumWorld");

  const prior = RESUME ? readJsonIfExists(STATE_FILE) : null;

  if (prior?.runtime?.authorizations && Array.isArray(prior.runtime.authorizations)) {
  for (const a of prior.runtime.authorizations) {
    if (!a?.authHash) continue;
    auths.set(String(a.authHash).toLowerCase(), {
      ...a,
      authHash: String(a.authHash),
      revoked: !!a.revoked,
    });
  }
  console.log("Restored authorizations:", auths.size);
}

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
    ).deploy(deployerAddr);
    await registry.waitForDeployment();

    pullSafe = await new ethers.ContractFactory(
      RecurPullSafeV2.abi,
      RecurPullSafeV2.bytecode,
      deployer
    ).deploy(await registry.getAddress());
    await pullSafe.waitForDeployment();

    world = await deployWorld(ContinuumWorld, deployer);
    await world.waitForDeployment();

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

    const ONE = 10n ** 18n;
    await (await token.mint(employer.addr, 5_000_000n * ONE)).wait();
    await (await token.mint(treasury.addr, 1_000_000n * ONE)).wait();
  }

  const ONE = 10n ** 18n;

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

  // PPO signing
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

function authHashFor(fields) {
  // IMPORTANT: this must match whatever your contracts treat as the authHash.
  // In your setup, authHash == digest == keccak(0x1901||domainSep||structHash).
  const sh = structHashFor(fields);
  return digestFor(sh);
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
  const sig = grantorAgent.owner.signingKey.sign(digest).serialized;

  const authHash = digest; // <- this is your canonical id in this runner’s const k = authHash.toLowerCase();

auths.set(k, {
  authHash,
  grantor: fields.grantor,
  grantee: fields.grantee,
  token: fields.token,
  validAfter: Number(fields.validAfter),
  validBefore: Number(fields.validBefore),
  revoked: false,
});

  return { fields, sig, authHash };
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
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = now - 60n;
    const validBefore = now + 365n * 24n * 3600n;

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

  const worldConn = new ethers.Contract(addresses.world, ContinuumWorld.abi, deployer);
  const tokenConn = new ethers.Contract(addresses.token, MockUSD.abi, provider);

  // Detect tickSafe by ABI presence (NOT by calling it)
  let HAS_TICKSAFE = false;
  try {
    worldConn.interface.getFunction("tickSafe");
    HAS_TICKSAFE = true;
  } catch {
    HAS_TICKSAFE = false;
  }
  console.log("World tick mode:", HAS_TICKSAFE ? "tickSafe()" : "tick()");

  async function worldTickStatic() {
    if (HAS_TICKSAFE) return worldConn.tickSafe.staticCall();
    return worldConn.tick.staticCall();
  }

  async function worldTickSend(overrides) {
    if (HAS_TICKSAFE) return worldConn.tickSafe(overrides);
    return worldConn.tick(overrides);
  }

  let lastBlock =
    doResume && prior?.lastBlock != null ? Number(prior.lastBlock) : await provider.getBlockNumber();

  const ifacePullSafe = new ethers.Interface(RecurPullSafeV2.abi);
  const ifaceRegistry = new ethers.Interface(RecurConsentRegistry.abi);
  const ifaceAgent = new ethers.Interface(AgentWallet.abi);

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
  logIndex: ev.logIndex ?? null,
  type: ev.name,
};

    const a = ev.args ?? [];
    if (ev.name === "PullExecutedDirect") {
      return { ...base, authHash: a[0], token: a[1], grantor: a[2], grantee: a[3], amount: a[4].toString() };
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

    updateState({
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
      authorizations: Array.from(auths.values()),
    });
  }

  let errorCount = Number(prior?.errorCount ?? 0);

function persistRuntime() {
  try {
    writeJsonAtomic(STATE_FILE, {
      ...deploymentState,
      lastBlock,
      errorCount,
      updatedAt: new Date().toISOString(),
      runtime: {
        authorizations: Array.from(auths.values()),
      },
    });
  } catch {}
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

  // -------------------------- Nonce strategy (robust) -------------------------
  let localNextNonce = await provider.getTransactionCount(deployerAddr, "pending");
  if (!Number.isFinite(Number(localNextNonce))) {
    localNextNonce = await provider.getTransactionCount(deployerAddr, "latest");
  }
  console.log("nonce(pending) boot:", localNextNonce);

  async function resyncNonceFromPending() {
    const p = await provider.getTransactionCount(deployerAddr, "pending");
    if (Number(p) > Number(localNextNonce)) localNextNonce = p;
  }

  async function buildFeeOverrides(bump = 0) {
    const fee = await provider.getFeeData().catch(() => null);
    const o = {};
    if (TICK_GAS_LIMIT != null) o.gasLimit = TICK_GAS_LIMIT;

    const mul = 1000n + BigInt(bump) * 125n; // +12.5% per attempt

    if (fee?.maxFeePerGas != null && fee?.maxPriorityFeePerGas != null) {
      o.maxFeePerGas = (fee.maxFeePerGas * mul) / 1000n;
      o.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * mul) / 1000n;
    } else if (fee?.gasPrice != null) {
      o.gasPrice = (fee.gasPrice * mul) / 1000n;
    }
    return o;
  }

  async function preflightTick() {
    try {
      await worldTickStatic();
      return { ok: true };
    } catch (e) {
      const { reason, data, msg } = extractEthersRevert(e);
      return { ok: false, reason: reason || msg, data };
    }
  }

  async function sendTickOnce() {
    await resyncNonceFromPending();

    for (let attempt = 0; attempt < TICK_SEND_RETRIES; attempt++) {
      await resyncNonceFromPending();

      const feeOverrides = await buildFeeOverrides(attempt);
      const nonce = localNextNonce;
      const overrides = { ...feeOverrides, nonce };

      try {
        const tx = await worldTickSend(overrides);
        localNextNonce = nonce + 1;
        return tx;
      } catch (e) {
        const { reason, msg } = extractEthersRevert(e);
        const m = msg || reason || "";

        if (isNonceUsedish(m)) {
          console.error(`tick nonce warning (nonce=${nonce}) -> resync+retry:`, m);
          await resyncNonceFromPending();
          await sleep(RETRY_SLEEP_MS);
          continue;
        }

        if (isMempoolFeeish(m)) {
          console.error(`tick mempool warning (nonce=${nonce}) -> fee bump retry:`, m);
          await sleep(RETRY_SLEEP_MS);
          continue;
        }

        throw e;
      }
    }

    throw new Error(`tick send failed after ${TICK_SEND_RETRIES} retries`);
  }

  // -------------------------- Tick loop --------------------------------------
  let ticking = false;
  let backoffMs = 0;

  setInterval(async () => {
    if (ticking) return;
    if (backoffMs > 0) return;

    ticking = true;
    try {
      const pf = await preflightTick();
      if (!pf.ok) {
        errorCount += 1;
        updateState({ errorCount, lastTickAt: Date.now(), lastTickError: { reason: pf.reason, data: pf.data } });
        persistRuntime();

        if (SKIP_ON_PREFLIGHT_REVERT) {
          console.error("tick preflight reverted:", pf.reason);
          return;
        }
      }

      const tx = await sendTickOnce();
      if (!tx) return;

      const rcpt = await tx.wait();
      updateState({ lastTickAt: Date.now(), lastTickError: null });

      const tickCount = await worldConn.tickCount();

      const currentBlock = rcpt.blockNumber;
      const fromBlock = lastBlock + 1;
      const toBlock = currentBlock;

      if (toBlock >= fromBlock) {
        const logs = await provider.getLogs({ fromBlock, toBlock, address: watchAddrs });

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
          } catch {}
        }
        updateState({ recentEvents: recent });
        updateState({
  authorizations: Array.from(auths.values()).filter(a => a && a.authHash),
});

        for (const ev of recent) {
if (ev.type === "AuthorizationRevoked" && ev.authHash) {
  const k = String(ev.authHash).toLowerCase();
  const a = auths.get(k);
  if (a) a.revoked = true;
  else auths.set(k, { authHash: ev.authHash, revoked: true });
}

}

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
        console.log(
          `tick=${tickCount} employer=${ethers.formatUnits(bEmp, 18)} treasury=${ethers.formatUnits(bTre, 18)} nonceNext=${localNextNonce}`
        );
      }
    } catch (e) {
      const { reason, data, msg } = extractEthersRevert(e);
      errorCount += 1;
      updateState({ errorCount, lastTickAt: Date.now(), lastTickError: { reason: reason || msg, data } });
      persistRuntime();
      console.error("tick error:", reason || msg || e);

      backoffMs = Math.min(30_000, Math.max(2000, (backoffMs || 2000) * 2));
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
