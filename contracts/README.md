# Contracts

Short-window binary BTC/USD predictions on Arkade. This directory is **Layer 0** (`coinflip/contracts`)—strictly dependency-free `.ark` sources, compiled `.artifact.json` files, compiler harness, and Go Arkade VM tests. Runtime binding, digests, and transaction builders live in **Layer 1** (`coinflip/protocol`).

## PredictVault

`predict_vault.ark` (`PredictVaultV3`, compiled with `@arkade-os/compiler@0.1.0`). All-or-nothing call on where Bitcoin closes: higher (kind `2`: `ST > strike`) or lower (kind `3`: `ST < strike`). Exact strike pays the writer for both kinds.

- **Single-input standalone settlement.** The desk is the writer and funds `collateral` (the full payout); the bettor is the holder and paid `stake` to the desk when `OptionIntent` filled. `settle()` spends only the vault (`tx.inputs.length == 1`) with zero read fee and pays 100% of `collateral` to the winner (output 0).
- **Dual `checkSigFromStack` canonical fixing.** `settle(price, time, nonce, intentExpiry, diaSig, oracleSig)` verifies **both**:
  1. The pinned DIA EIP-712 `OracleUpdate` signature for `BTC/USD` (`price` in 18-decimal integer, `time` in `[expiry, expiry + 60]`), so the oracle cannot fabricate a price.
  2. `oraclePk`'s BIP340 Schnorr signature over `SHA256("BTCUSD-FIX" || "fix" || num2bin(expiry, 8) || num2bin(cents, 8) || num2bin(time, 8))`, committing a single canonical fixing per expiry so neither party can cherry-pick among DIA prints in `[expiry, expiry + 60]`.
- **Dust folding.** In `refund()`, any leg at or below `DUST` (`330` sats) is folded into the other party's output.
- **Three-tier exit & void model.** Replaces single-party writer unilateral exit so the desk cannot unroll and walk away from a payout:

| Tier | Function | Who | When | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `settle(price, time, nonce, intentExpiry, diaSig, oracleSig)` | Anyone, with operator | After `expiry`, with DIA + oracle signed fixing | Winner receives full `collateral` |
| 1 | `reboard()` | Anyone, with operator (`executord` or page) | After an unroll or before expiry (v2 intent proof, `onchain_output_indexes == "[]"`) | Vault returns off-chain unchanged via `this.tunnel(activeInputIndex - 1)` |
| 1 | `refund()` | Anyone, with operator | After `expiry + voidAfter` (24h) | Prediction is void: `stake` back to holder, remainder to writer (dust folded) |
| 1 | `close(writerSig, holderSig)` | Desk and player | Any time | Cooperative split |
| 2 | `refundBackup(backupSig)` | Backup emulator via `tweak(backupPk, refund)` | After `older(fallbackDelay)` (7d mainnet / ~6.1h Mutinynet) | Void refund on L1 without primary operator (after `expiry + voidAfter`; supports L1 fee-sponsor input) |
| 3 | `unilateral(writerSig, holderSig)` | Desk and player (2-of-2) | After `older(finalExitDelay)` (8d mainnet / ~30h Mutinynet) | Mutual last-resort L1 exit |

Constructor: `kind`, `writerPk`, `holderPk`, `writerScript`, `holderScript`, `strike`, `collateral`, `stake`, `expiry`, `oraclePk`, `backupPk`, `voidAfter`, `fallbackDelay`, `finalExitDelay`.

> **Mainnet note:** On Mutinynet, if `BACKUP_EMULATOR_PUBKEY` / `PINNED_BACKUP_PUBKEY` is unset, the desk and page fall back to the primary emulator key as a placeholder. On Bitcoin mainnet (`NETWORK=bitcoin`), both the desk and page fail closed unless an independent backup emulator pubkey is explicitly configured, and `exit` / `fallbackDelay` / `finalExitDelay` scale to mainnet `arkd`'s 7-day `unilateralExitDelay` (`605,184s` / `605,184s` / `691,200s`). See `docs/mainnet-runbook.md`.
>
> **Tier-2 L1 trust model:** Because Bitcoin L1 does not execute the Arkade VM, the `refundBackup` tapscript leaf enforces only `older(fallbackDelay)` and a Schnorr signature from the script-tweaked `backupPk` (`scripts/backup-refund.ts` signs with that plain key). After `fallbackDelay` (7 days on mainnet), the backup key custodian can spend any still-unsettled vault on L1 and is trusted to sign only valid void refunds.

## OptionIntent

`option_intent.ark`. Timed RFQ funding lock filled before a vault exists (used with `side == 1` for Predict): the bettor locks `stake` (`premium`), and the desk `finalize()`s by paying `stake` to `solverScript` and locking `collateral` in `PredictVault`. If the desk does not fill before `deadline`, the bettor can `cancel()` immediately (`OP_CHECKTIME`), `executord` can auto-refund via `cancelCltv` (`after(deadline)` + `cancelAuto()`), or the bettor can exit on Bitcoin L1 after `exit`.

## Import

`predict_vault.artifact.json` and `option_intent.artifact.json` are the dependency-free Layer 0 artifacts (`coinflip/contracts`):

```ts
import { optionIntentArtifact, predictVaultArtifact } from "coinflip/contracts";
```

The Layer 1 protocol SDK (`coinflip/protocol`) re-exports the artifacts together with contract binding, fixing digests, payoff math, transaction builders, and pluggable transport/feed ports:

```ts
import {
  optionIntentArtifact,
  predictVaultArtifact,
  intentProgram,
  predictVaultProgram,
  bindContracts,
  predictFixDigest,
  buildPredictSettle,
  buildRefund,
  predictSettlePriceCents,
  submit,
  settlePayouts,
} from "coinflip/protocol";
```

`predictVaultProgram()` and `intentProgram()` load the committed artifacts. `bindContracts` derives the intent and vault a desk quotes. `predictFixDigest` builds the 32-byte digest `oraclePk` signs. `buildPredictSettle` and `buildRefund` construct standalone settlement and void-refund spends, `submit` sends them to the Arkade emulator, and `settlePayouts` computes the winner payout.
