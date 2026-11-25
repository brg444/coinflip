# Contracts

Cash-settled options and short-window binary predictions on Arkade. The compiler artifacts are committed in this directory. Consumers import those artifacts and the protocol library from one module, `contracts/index.ts` (package export `arkade-options/contracts`).

## PredictVault

`predict_vault.ark` (compiled with `@arkade-os/compiler@0.1.0`). All-or-nothing call on where Bitcoin closes: higher (kind 2: `ST > strike`) or lower (kind 3: `ST < strike`). Exact strike pays the writer for both kinds.

- **Inputs & outputs.** The desk is the writer and funds `collateral` (the full payout); the bettor is the holder and paid `stake` to the desk when `OptionIntent` filled. `settle()` spends the vault as input 0 and `AttestationBeacon` as input 1. Output 0 is the beacon continuation with `readFee` sats (`1,000`) added; payouts start at output 1 and sum to `collateral - readFee`.
- **Beacon read & canonical fixing.** Reads the single committed fixing for `expiry` from the beacon state packet (first 8 bytes = price in USD cents, next 8 bytes = sample time), preventing either side from cherry-picking among multiple DIA prints inside `[expiry, expiry + 60]`.
- **Dust folding.** Any payout leg at or below `DUST` (`330` sats) is folded into the other party's output.
- **Three-tier exit & void model.** Replaces single-party writer unilateral exit so the House cannot unroll and walk away from a payout:

| Tier | Function | Who | When | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `settle()` | Anyone, with operator | After `expiry`, with committed beacon fixing | Winner paid (`collateral - readFee`) |
| 1 | `reboard()` | Anyone, with operator (`executord` or page) | After an unroll or before expiry (v2 intent proof, `onchain_output_indexes == "[]"`) | Vault returns off-chain unchanged via `this.tunnel(activeInputIndex - 1)` |
| 1 | `refund()` | Anyone, with operator | After `expiry + voidAfter` (24h) | Prediction is void: `stake` back to holder, remainder to writer (dust folded) |
| 1 | `close(writerSig, holderSig)` | House and player | Any time | Cooperative split |
| 2 | `refundBackup(backupSig)` | Backup emulator via `tweak(backupPk, refund)` | After `older(fallbackDelay)` (~6.1h) | Void refund on L1 without primary operator (after `expiry + voidAfter`; supports L1 fee-sponsor input) |
| 3 | `unilateral(writerSig, holderSig)` | House and player (2-of-2) | After `older(finalExitDelay)` (~30h > `voidAfter`) | Mutual last-resort L1 exit |

Constructor: `kind`, `writerPk`, `holderPk`, `writerScript`, `holderScript`, `strike`, `collateral`, `stake`, `expiry`, `beaconTxid`, `beaconGidx`, `readFee`, `backupPk`, `voidAfter`, `fallbackDelay`, `finalExitDelay`.

> **Mainnet note:** On Mutinynet, if `BACKUP_EMULATOR_PUBKEY` / `PINNED_BACKUP_PUBKEY` is unset, the desk and page fall back to the primary emulator key as a placeholder. On Bitcoin mainnet (`NETWORK=bitcoin`), both the desk and page fail closed unless an independent backup emulator pubkey is explicitly configured, and `exit` / `fallbackDelay` / `finalExitDelay` scale to mainnet `arkd`'s 7-day `unilateralExitDelay` (`605,184s` / `605,184s` / `691,200s`). See `docs/mainnet-runbook.md`.
>
> **Tier-2 L1 trust model:** Because Bitcoin L1 does not execute the Arkade VM, the `refundBackup` tapscript leaf enforces only `older(fallbackDelay)` and a Schnorr signature from the script-tweaked `backupPk` (`scripts/backup-refund.ts` signs with that plain key). After `fallbackDelay` (7 days on mainnet), the backup key custodian can spend any still-unsettled vault on L1 and is trusted to sign only valid void refunds.

## OptionVault

`option_vault.ark`. The writer locks BTC. Kind 0 is a covered call. Kind 1 is a limited put. Settlement pays the holder in BTC from that lock using the `AttestationBeacon` read, `[expiry, expiry + 60]` window, and `330`-sat dust folding.

| Function | |
| --- | --- |
| `settle()` | Anyone, once the clock has reached `expiry`. This coin is input 0. The attestation beacon is input 1. The price is that beacon's slot for this expiry. |
| `close(writerSig, holderSig)` | Writer and holder together. |
| `unilateral(writerSig)` | Writer, after `exit`. |

Constructor: `kind`, `writerPk`, `holderPk`, `writerScript`, `holderScript`, `strike`, `collateral`, `expiry`, `beaconTxid`, `beaconGidx`, `readFee`, `exit`.

## OptionIntent

`option_intent.ark`. Timed RFQ funding lock filled before a vault exists. `side == 0` (options): writer locks `collateral`, solver pays `premium` and funds `OptionVault`. `side == 1` (Predict): holder locks stake (`premium`), solver pays stake to `solverScript` and funds `PredictVault` with `collateral`. Maker can `cancel()` immediately after `deadline` (`OP_CHECKTIME`), `executord` can auto-refund via `cancelCltv` (`after(deadline)` + `cancelAuto()`), or maker can exit on Bitcoin after `exit`.

## AttestationBeacon

`attestation_beacon.ark`. A price registry holding the eight newest 5-minute closes. The vault reads it by spending it in the same transaction. Each `attest` requires **both** the pinned DIA EIP-712 signature and an `adminPk` Schnorr signature over `(domain, "attest", ctrlTxid, ctrlGidx, round, expiry, cents, time)`, enforces `expiry % 300 == 0` and strictly advancing close times (`expiry > lastExpiry`) so nobody can front-run a close or flush and overwrite an earlier fixing, and never allows the oracle to invent a price.

| Function | |
| --- | --- |
| `attest(expiry, price, time, nonce, intentExpiry, sig, adminSig)` | Writes one fixing. `price` is the DIA 18-decimal integer. Verifies both the pinned DIA EIP-712 signature and `adminPk`'s Schnorr signature, requires `expiry % 300 == 0`, `expiry > lastExpiry`, and `time` in `[expiry, expiry + expiryLag]`, and stores USD cents. |
| `read(selfIndex)` | Carries the state forward and adds `readFee`. No signature. |
| `migrate(next, opSig)` | `adminPk` moves the coin to another script. |
| `reboard(opSig)` | `adminPk` renews the beacon VTXO in an Arkade batch round (v2 intent proof, outpoint-bound `opSig`, `this.tunnel` + identity asset preserved). |
| `reseed(round, lastExpiry, opSig)` | `adminPk` restores a zero-value 329-byte `STATE` packet (`round`, monotonic `lastExpiry`, zeroed slot values) strictly when the renewed input has no `STATE` packet (`!tx.inputs[0].packet.has(STATE)`). Cannot invent prices or run on an already-seeded beacon. |
| `unilateral(adminSig)` | `adminPk`, after `exit`. |

Constructor: `ctrlTxid`, `ctrlGidx`, `domain`, `expiryLag`, `readFee`, `adminPk`, `exit`. The DIA signer key is pinned in the script.

## Import

`predict_vault.artifact.json`, `option_vault.artifact.json`, `option_intent.artifact.json`, and `attestation_beacon.artifact.json` are the committed artifacts. The protocol library is `protocol/`. New code takes both from this module:

```ts
import {
  predictVaultArtifact,
  optionVaultArtifact,
  attestationBeaconArtifact,
  predictVaultProgram,
  vaultProgram,
  beaconProgram,
  bindContracts,
  bindBeacon,
  buildSettle,
  submit,
  slotPrice,
  settlePayouts,
} from "arkade-options/contracts";
```

`predictVaultProgram()`, `vaultProgram()`, and `beaconProgram()` load the committed artifacts. `bindContracts` derives the intent and vault a desk quotes. `bindBeacon` derives the beacon from a `beaconIdOf` id. `buildSettle` spends the vault and the beacon together, and `submit` sends that transaction. `slotPrice` is the fixing that vault would accept. `settlePayouts` is what that spend pays.

Programs load the JSON in this directory. The design of the beacon is in [beacon.md](beacon.md).
