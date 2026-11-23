# Contracts

Cash-settled options and short-window binary predictions on Arkade. The compiler artifacts are committed in this directory. Consumers import those artifacts and the protocol library from one module, `contracts/index.ts` (package export `arkade-options/contracts`).

## PredictVault

`predict_vault.ark`. All-or-nothing call on where Bitcoin closes: higher (kind 2: `ST > strike`) or lower (kind 3: `ST < strike`). Exact strike pays the writer for both kinds.

- **Inputs & outputs.** The desk is the writer and funds `collateral` (the full payout); the bettor is the holder and paid the stake to the desk when `OptionIntent` filled. `settle()` spends the vault as input 0 and `AttestationBeacon` as input 1. Output 0 is the beacon continuation with `readFee` sats added; payouts start at output 1 and sum to `collateral - readFee`.
- **Beacon read & window.** Reads the newest matching fixing for `expiry` from the beacon state packet (first 8 bytes = price in USD cents, next 8 bytes = sample time). Rejects any sample time outside `[expiry, expiry + 60]`.
- **Dust folding.** Any payout leg at or below `DUST` (`330` sats) is folded into the other party's output.

| Function | |
| --- | --- |
| `settle()` | Anyone, once the clock has reached `expiry`. Spends input 0 (vault) and input 1 (beacon). |
| `close(writerSig, holderSig)` | Writer and holder together. |
| `unilateral(writerSig)` | Writer, after `exit`. |

Constructor: `kind`, `writerPk`, `holderPk`, `writerScript`, `holderScript`, `strike`, `collateral`, `expiry`, `beaconTxid`, `beaconGidx`, `readFee`, `exit`.

## OptionVault

`option_vault.ark`. The writer locks BTC. Kind 0 is a covered call. Kind 1 is a limited put. Settlement pays the holder in BTC from that lock using the same beacon read, `[expiry, expiry + 60]` window, `330`-sat dust folding, and spend paths as `PredictVault`.

| Function | |
| --- | --- |
| `settle()` | Anyone, once the clock has reached `expiry`. This coin is input 0. The attestation beacon is input 1. The price is that beacon's slot for this expiry. |
| `close(writerSig, holderSig)` | Writer and holder together. |
| `unilateral(writerSig)` | Writer, after `exit`. |

Constructor: `kind`, `writerPk`, `holderPk`, `writerScript`, `holderScript`, `strike`, `collateral`, `expiry`, `beaconTxid`, `beaconGidx`, `readFee`, `exit`.

## OptionIntent

`option_intent.ark`. Timed RFQ funding lock filled before a vault exists. `side == 0` (options): writer locks `collateral`, solver pays `premium` and funds `OptionVault`. `side == 1` (Predict): holder locks stake (`premium`), solver pays stake to `solverScript` and funds `PredictVault` with `collateral`. Maker can `cancel()` after `deadline` or exit after `exit`.

## AttestationBeacon

`attestation_beacon.ark`. A price registry holding the eight newest fixings. The vault reads it by spending it in the same transaction. A signature names this beacon and one expiry, so a print for one expiry cannot fill another.

| Function | |
| --- | --- |
| `attest(expiry, price, time, nonce, intentExpiry, sig)` | Writes one fixing. `price` is the DIA 18-decimal integer. The script checks the EIP-712 signature, stores USD cents, and requires the timestamp in `[expiry, expiry + expiryLag]`. |
| `read(selfIndex)` | Carries the state forward and adds `readFee`. No signature. |
| `migrate(next, opSig)` | `adminPk` moves the coin to another script. |
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
