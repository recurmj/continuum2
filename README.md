# Continuum (EVM-real)

Continuum is a closed-loop, permissioned-pull micro-economy that can run indefinitely.

**Key property:** after initial seeding, all motion is executed via signed Authorization objects (PPOs)
through `RecurPullSafeV2`, under caps + time windows + global revocation in `RecurConsentRegistry`.

## Contracts

- `RecurConsentRegistry.sol` — RIP-002 registry (revocation + accounting; trusted executor gating)
- `RecurPullSafeV2.sol` — RIP-001 executor (EIP-712 + EIP-1271 support)
- `AgentWallet.sol` — minimal smart-wallet agent (EIP-1271) that stores inbound edges and executes pulls when ticked
- `ContinuumWorld.sol` — public crank that advances ticks and asks agents to execute due edges

## How Continuum avoids the "it's just bots" critique

`ContinuumWorld` has **no custody and no discretion**. It cannot pull funds.
It only calls `AgentWallet.tick(t)`.

Each `AgentWallet` is the **grantee** and calls `RecurPullSafeV2.pull()` itself, preserving:
`msg.sender == auth.grantee == receiver`.

## Next

### Quickstart (local)

1) Build contracts

```bash
cd continuum/contracts
forge build
```

2) Start a local chain

```bash
anvil
```

3) Run Continuum

```bash
cd ../runner
npm i
node src/run.js
```

### Persistence + resume (for long-running uptime)

The runner writes a small `state.json` (deployment addresses + last processed block)
so it can **resume** after process restarts (as long as the underlying chain is still running).

Defaults:

- `RESUME=1` (enabled)
- `STATE_FILE=./state.json`

Example:

```bash
cd continuum/runner
RESUME=1 STATE_FILE=./state.json node src/run.js
```

Healthcheck endpoint:

- `GET /healthz` returns 200 when ticks are advancing, otherwise 503.

You should see the world ticking and balances evolving. At tick 5 the runner triggers a
single **shock** (an intentionally over-cap pull) which should be contained.
