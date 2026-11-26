# COINFLIP — Arkade Application & Contract Reference Guide

This guide distills the production architecture, smart-contract patterns, security invariants, and upstream compiler/SDK lessons from **COINFLIP** (`PredictVaultV3` + `OptionIntent` live on Bitcoin mainnet and Mutinynet). It is written for Arkade application builders, smart-contract authors, compiler/SDK engineers, and agent-skill designers.

---

## 1. Layered Architecture & Dependency DAG

COINFLIP enforces a strict, acyclic 3-layer dependency graph verified automatically on every test run (`protocol/architecture.test.ts`):

```text
Layer 0  contracts/       Zero internal dependencies (coinflip/contracts)
           │              .ark sources, committed .artifact.json, Go VM parity tests
           ▼
Layer 1  protocol/        Depends only on contracts/ (coinflip/protocol)
           │              Contract binding, digests, payoff & pricing math, tx builders,
           │              oracle verification, SQLite storage, pluggable ports
           ▼
Layer 2  oracle/          Stateless DIA ingest + SQLite WAL fixing signer
         desk/            Nostr RFQ quoter + float manager + atomic filler
         settle/          Permissionless keyless vault settler + void refunder
         app/             Hardened mobile-first browser UI (esbuild bundle)
```

### Key structural rules

1. **Zero cross-service imports.** `oracle/`, `desk/`, `settle/`, and `app/` never import each other; all shared logic lives in `protocol/`.
2. **Pluggable ports (`protocol/ports.ts`).** Every external transport and feed has a minimal interface (`RfqTransport`, `RfqClient`, `PositionFeed`, `OracleFeedPort`, `SpotFeedPort`, `VolSurfacePort`) plus an in-memory deterministic `InMemoryRfqBus` so the full RFQ → bind → dual-signed fixing → standalone settlement lifecycle runs with zero network I/O (`protocol/ports.test.ts`).
3. **Byte-pinned Layer 0 artifacts.** `contracts/index.test.ts` recompiles every `.ark` file and asserts exact deep equality against the committed `.artifact.json`, while `contracts/go/` executes the same artifacts inside the real Go Arkade VM and asserts byte-for-byte TS ↔ Go Taproot script parity.

---

## 2. Core Arkade Contract Patterns

### Pattern A: Standalone Dual-`checkSigFromStack` Settlement (`PredictVaultV3`)

Early Arkade oracle prototypes used a shared on-chain "attestation beacon" coin co-spent by every settling vault. In production, a singleton beacon creates UTXO contention, requires a funded oracle wallet, adds read-fee accounting, and breaks parallel settlement.

`contracts/predict_vault.ark` (`PredictVaultV3`) eliminates the beacon completely:

- **Single input (`tx.inputs.length == 1`), zero read fee, full parallel settlement.** Anyone can settle any expired vault independently with zero keys and zero fee wallet.
- **Dual cryptographic attestation inside `settle()`:**
  1. **Pinned DIA EIP-712 price update** (`checkSigFromStack` against pinned `DIA_PUBKEY`, verifying `BTC/USD` EIP-712 struct/domain hash, `price > 0`, and `time` inside `[expiry, expiry + 60]`). The oracle **cannot fabricate a price** — it can only select a genuine DIA-signed print.
  2. **Canonical fixing co-signature** (`checkSigFromStack` against `oraclePk` over `SHA256("BTCUSD-FIX" || "fix" || num2bin(expiry, 8) || num2bin(cents, 8) || num2bin(time, 8))`). Because multiple DIA updates can arrive inside `[expiry, expiry + 60]`, the oracle commits to **one canonical fixing per expiry**, preventing either party from cherry-picking a favorable tick.
- **Exact-tie & integer-math discipline.** Price conversion uses pure integer rounding `(price + 5e15) / 1e16` (`1 DIV`, `0 MUL`), and exact equality (`cents == strike`) pays the writer for both `kind == 2` (higher) and `kind == 3` (lower).

### Pattern B: Atomic Pre-Vault RFQ Lock (`OptionIntent`, `side == 1`)

Before the desk commits capital, the bettor funds an `OptionIntent` (`contracts/option_intent.ark`, `side == 1`):

1. **Bettor** locks `stake` (`premium`) into the deterministic `OptionIntent` address derived independently by both page and desk (`bindContracts()`).
2. **Desk (`finalize()`)** atomically claims `stake` to `solverScript` (`output 0`) and funds `collateral` (full payout) into `PredictVaultV3` (`output 1`) in a single Arkade transaction before `deadline`.
3. **Timeout safety:** if the desk does not fill before `deadline`, the bettor (or anyone) can call `cancel()` immediately via `OP_CHECKTIME`, `executord` automatically triggers `cancelAuto()` via the `cancelCltv` leaf, or the bettor can unilaterally exit to Bitcoin L1 after `exit`.

### Pattern C: Three-Tier Recovery & Custody Ladder

Single-party unilateral exit is unsafe on a two-party bet vault: if the writer could unilaterally unroll and sweep after `exit`, the desk could walk away from a losing bet. `PredictVaultV3` replaces single-party exit with three escalating tiers:

| Tier | Function | Execution layer | Trigger | Enforced by | Trust assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1a** | `settle(...)` | Arkade VM | `now >= expiry` + DIA & oracle sigs | Arkade VM + `arkd` + emulator | Trustless price (DIA) + liveness/non-equivocation of `oraclePk` |
| **1b** | `reboard()` | Arkade VM (`tunnel`) | Before VTXO expiry / after unroll | `this.tunnel(activeInputIndex - 1)` + v2 intent proof (`onchain_output_indexes == "[]"`) | Permissionless renewal via `executord` or browser page |
| **1c** | `refund()` | Arkade VM | `now >= expiry + voidAfter` (24h) | Arkade VM (`CHECKTIME` + dust-folded split: `stake` → holder, remainder → writer) | Zero oracle dependency if DIA/oracle fails to fix |
| **1d** | `close(wSig, hSig)` | Arkade VM | Anytime | 2-of-2 writer + holder signatures | Mutual cooperative settlement |
| **2** | `refundBackup(bSig)` | Bitcoin L1 Tapscript | `older(fallbackDelay)` (7d mainnet / ~6.1h Mutinynet) | L1 CSV + tweaked `backupPk` (`tweak(backupPk, refund)`) | **Explicit trust disclosure:** Bitcoin L1 cannot evaluate Arkade VM scripts, so after `fallbackDelay` the independent `BACKUP_KEY` custodian is trusted to sign only valid void refunds (`scripts/backup-refund.ts`) |
| **3** | `unilateral(wSig, hSig)` | Bitcoin L1 Tapscript | `older(finalExitDelay)` (8d mainnet / ~30h Mutinynet) | L1 CSV + 2-of-2 writer + holder signatures | Mutual last-resort escape hatch if both primary and backup operators vanish |

> **Why `fallbackDelay >= unilateralExitDelay` matters:** `arkd` rejects any VTXO whose shortest L1 CSV exit leaf is shorter than the server's `unilateralExitDelay` (`605,184s` / 7 days on mainnet; `2,048s` on Mutinynet). COINFLIP verifies `arkd /v1/info` on startup (`assertServerExit()`) and pins `fallbackDelay = 605,184s`, `finalExitDelay = 691,200s` on mainnet (`protocol/network.ts`).

---

## 3. Production Security & Operational Invariants

Every production hardening rule below corresponds directly to an audit finding fixed and tested in this repository:

1. **Oracle anti-equivocation & crash safety (`oracle/store.ts`, `oracle/service.ts`):**
   - Fixings and samples persist in `node:sqlite` with `PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;` and `PRIMARY KEY (expiry)` with `INSERT OR IGNORE`. Once a canonical fixing for `expiry` is committed, it is immutable across crashes and restarts.
   - A proactive background finalizer commits due fixings on startup, on every DIA ingest past `expiry + 60`, and on a 1-second timer (with a 30s fallback grace if DIA stops ticking).
   - Public endpoints (`GET /api/fixing`, `GET /api/prices`, `GET /api/status`) are **strictly read-only** — untrusted HTTP traffic can never trigger signing or DB writes.
2. **Anti-snipe dual-feed pricing (`desk/spot.ts`, `desk/main.ts`):**
   - Spot price is computed from the **more adverse** of DIA oracle spot and the median of Coinbase, Kraken, and Binance, preventing latency arbitrage during the ~25s DIA cadence.
   - Before filling a funded `OptionIntent`, the desk re-fetches live spot and refuses fills if spot moved adversely beyond the desk's edge during the 30-second lock window.
3. **Serialized quote admission (`desk/rate-limit.ts`, `desk/main.ts`):**
   - Concurrent Nostr RFQ bursts cannot race across `await refreshFloat()` to double-commit float or bypass open-quote caps: `AsyncMutex` + `reserveQuote()` serializes rate limits, strike/total exposure caps, open-quote limits, and float checks atomically per quote.
4. **Weight-bounded coin selection (`desk/fill.ts`):**
   - `selectFloat()` caps input count (`MAX_FLOAT_INPUTS = 12`) to stay safely within Arkade transaction weight and checkpoint limits, and prefers exact/minimal-change VTXOs.
5. **Fail-closed mainnet keys & network pinning (`scripts/demo.mjs`, `protocol/network.ts`, `app/src/fund.ts`):**
   - On `NETWORK=bitcoin`, startup aborts unless `ORACLE_KEY`, `DESK_KEY`, `ORACLE_ADMIN`, and an independent `BACKUP_EMULATOR_PUBKEY` (distinct from desk, oracle, and primary emulator) are explicitly provided. Keys are never auto-generated or written to disk on mainnet.
   - Both desk and page assert `/v1/info` network ID and `unilateralExitDelay` before quoting or deriving addresses.
6. **Pasted-address signer-key trap (`app/src/fund.ts`, `app/desk.js`):**
   - An Arkade address encodes the *tweaked Taproot output key* (`DefaultVtxo`), not the user's raw signing pubkey. When a user pastes an address instead of connecting via Arkade wallet handoff (which returns both `address` and raw `pubkey`), `verifiedSignerKey()` returns `undefined`. Payouts (`holderScript`) and automatic settlement/refund work normally, while L1 `unilateral` 2-of-2 recovery requires a verified raw signer key — so the UI surfaces an explicit warning (`#bet-pasted-warn`).
7. **Browser & container hardening (`scripts/page-server.mjs`, `nginx.conf`, `site.Dockerfile`, `coinflip.Dockerfile`):**
   - Only the static/proxy page port (`4173`) is public; oracle (`8789`), desk (`8788`), and settler (`8790`) bind strictly to `127.0.0.1`.
   - Strict CSP (`default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `.map` 404 blocking, and `SOURCEMAP=0` on production builds.

---

## 4. Upstream Compiler, SDK, `executord`, & Wallet-Standard Feedback

Building and operating COINFLIP on Bitcoin mainnet surfaced ten concrete friction points where the repo currently carries explicit workarounds. Future releases of `@arkade-os/compiler`, `@arkade-os/sdk`, `executord`, and Arkade wallet handoff specs can eliminate all ten:

| # | Area | Workaround currently required in COINFLIP | Where in repo | Upstream improvement |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Compiler (`0.1.0`) | Post-compile AST/ASM rewrite `forTwoKeyOperator()` replaces `<OPERATOR_KEY:X> OP_CHECKSIG` with `<SERVER_KEY> OP_CHECKSIGVERIFY <EMULATOR_KEY:X> OP_CHECKSIG`, injects `[serverSig, emulatorSig]`, and strips nondeterministic `updatedAt`/`codeHash`. | [compile.mjs](../contracts/compile.mjs) | Emit dual-key (`server` + `emulator`) operator leaves natively and guarantee deterministic artifact JSON output. |
| 2 | Compiler / `executord` | `push()` rewrites integer literals `> 2^53 - 1` (e.g., `1e16` DIA scaling factor) into minimal-scriptnum hex literals because `executord` parses JSON decimals as IEEE-754 floats. | [compile.mjs](../contracts/compile.mjs#L6-L13) | Support arbitrary-precision integer literals (or string-encoded bigints) in artifact JSON and `executord`. |
| 3 | Compiler / `executord` | `OptionIntent` defines two functionally identical functions (`cancel()` using `OP_CHECKTIME` for instant UX and `cancelAuto()` with `after(deadline)` CLTV leaf for `executord`) because `executord` cannot schedule purely on `OP_CHECKTIME`. | [option_intent.ark](../contracts/option_intent.ark) | Allow `executord` templates to schedule on `OP_CHECKTIME` or unify cooperative/CLTV timelock annotations in `.ark`. |
| 4 | `executord` | `executorArtifact()` manually flattens composite `ScriptPubKey` constructor inputs into `<name>.program` (`bytes32`) + `<name>.version` (`int`) and encodes scriptnums/even-compressed keys by hand. | [executor.ts](../protocol/executor.ts#L24-L35) | Accept standard compiler `ContractArtifact` JSON directly without schema flattening. |
| 5 | SDK (`0.5.13`) | `exitSequence()` manually computes BIP68 time-based relative locktime `(1n << 22n) | (seconds / 512n)` and validates multiples of 512s. | [programs.ts](../protocol/programs.ts#L7-L15) | Provide a first-class BIP68 helper in `@arkade-os/sdk` accepted directly by `ArkadeProgramScript` constructor args. |
| 6 | SDK / `arkd` | `finalize.ts` implements ~290 LOC of manual 2-phase checkpoint cosigning, `getPendingTxs` ownership proofs, indexer fallback resubmission, and bounded tracking of `VTXO_ALREADY_SPENT` stuck txs when emulator `submitTx` does not finalize. | [finalize.ts](../desk/finalize.ts) | Unify covenant + signed multi-input submission/finalization in `@arkade-os/sdk` with idempotent retry & automatic cache reconciliation. |
| 7 | SDK (`0.5.13`) | Browser permissionless paths (`registerIntent`, `cancelIntent`, `reboardVaultFromPage`) must generate an ephemeral throwaway `SingleKey` (`sessionHex()`) just to satisfy `Arkade.connect({ identity })`. | [fund.ts](../app/src/fund.ts#L259-L274) | Allow keyless / read-only + permissionless-covenant `Arkade.connect()` sessions without a dummy signing key. |
| 8 | Wallet Handoff | Arkade addresses only reveal the tweaked Taproot output key; multi-party contracts (`OptionIntent`, `PredictVaultV3`) also need the user's raw x-only signer pubkey for L1 recovery leaves. | [fund.ts](../app/src/fund.ts#L244-L257), [wallet-link.ts](../app/src/wallet-link.ts) | Standardize returning the raw x-only signer pubkey alongside the address in Arkade wallet-connect callbacks (verified via `DefaultVtxo` derivation). |
| 9 | Contract / Protocol | Permissionless `reboard()` checks `onchain_output_indexes == "[]"` via `INSPECTINTENTMESSAGE` so anyone can renew an unrolled vault, which still allows a griefer to submit an invalid/delete intent if not guarded by intent-action inspection. | [predict_vault.ark](../contracts/predict_vault.ark) | Add first-class intent-type / renewal-intent helpers in `.ark` standard library so permissionless `reboard()` explicitly requires `register` intents and forbids `delete`. |
| 10 | Pattern / Docs | Standalone `checkSigFromStack` oracle verification (0 read fee, 1 input, parallel settlement) proved dramatically simpler and safer than shared UTXO attestation beacons. | [predict_vault.ark](../contracts/predict_vault.ark) | Document standalone `checkSigFromStack` attestations as the default Arkade oracle pattern, reserving shared state coins strictly for cross-vault invariants (e.g., AMM pools). |

---

## 5. Checklist for a Future `PredictVaultV4`

Live Bitcoin mainnet contracts (`contracts/predict_vault.{ark,artifact.json}` and `contracts/option_intent.{ark,artifact.json}`) are frozen to preserve address compatibility for deployed positions. When designing a clean-break `PredictVaultV4`, incorporate these upgrades:

1. **Domain-separated fixing digest:** Include network tag (`"bitcoin"` vs `"mutinynet"`) and contract version (`"v4"`) inside `fixMsg` so a Mutinynet fixing signature can never replay on mainnet even if an operator accidentally reuses keys.
2. **Strict single-input check on `refund()`:** Mirror `settle()`'s `require(tx.inputs.length == 1)` on cooperative Arkade `refund()` (while keeping fee-sponsor flexibility on L1 `refundBackup()`).
3. **Restrict `reboard()` intent action:** Inspect the BIP322/Arkade intent message type to allow only renewal/registration intents (`"register"`) and reject `"delete"` intents.
4. **Threshold or independent oracle signer:** Replace single-key `oraclePk` with a 2-of-3 / FROST Schnorr aggregate key (or independent third-party fixing signer) so canonical-fixing liveness and non-equivocation do not depend on a single hot oracle process.
5. **Typed `tx.locktime` / `older()` abstractions:** Adopt upstream compiler/SDK BIP68 and dual-key operator primitives once shipped so `contracts/compile.mjs` post-processing shrinks to zero.

---

## 6. Quick Links

- Contract sources & Go VM suite: [contracts/README.md](../contracts/README.md)
- Bitcoin mainnet provisioning & incident runbook: [docs/mainnet-runbook.md](./mainnet-runbook.md)
- Architecture boundary enforcement test: [protocol/architecture.test.ts](../protocol/architecture.test.ts)
- Deterministic zero-network lifecycle test: [protocol/ports.test.ts](../protocol/ports.test.ts)
