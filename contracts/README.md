# Contracts

Cash-settled covered calls and limited puts. Two contracts. The compiler artifacts are committed in this directory. A third party imports those artifacts and the protocol library from one module, `contracts/index.ts` (package export `arkade-options/contracts`).

## OptionVault

`option_vault.ark`. The writer locks BTC. Kind 0 is a covered call. Kind 1 is a limited put. Settlement pays the holder in BTC from that lock. The arithmetic is in the contract source.

| Function | |
| --- | --- |
| `settle()` | Anyone, once the clock has reached `expiry`. This coin is input 0. The attestation beacon is input 1. The price is that beacon's slot for this expiry. |
| `close(writerSig, holderSig)` | Writer and holder together. |
| `unilateral(writerSig)` | Writer, after `exit`. |

Constructor: `kind`, `writerPk`, `holderPk`, `writerScript`, `holderScript`, `strike`, `collateral`, `expiry`, `beaconTxid`, `beaconGidx`, `readFee`, `exit`.

## AttestationBeacon

`attestation_beacon.ark`. A price registry. The vault reads it by spending it in the same transaction. A signature names this beacon and one expiry, so a print for one expiry cannot fill another.

| Function | |
| --- | --- |
| `attest(expiry, price, time, sigs)` | Writes one fixing. `threshold` of the oracle signatures must match that expiry, price, and sample time. The clock must have reached `expiry + expiryLag`. |
| `read(selfIndex)` | Carries the state forward and adds `readFee`. No signature. |
| `migrate(next, opSig)` | `adminPk` moves the coin to another script. |
| `unilateral(adminSig)` | `adminPk`, after `exit`. |

Constructor: `ctrlTxid`, `ctrlGidx`, `signers`, `signersN`, `threshold`, `domain`, `expiryLag`, `readFee`, `adminPk`, `exit`.

## Import

`option_vault.artifact.json` and `attestation_beacon.artifact.json` are the artifacts. The protocol library is `protocol/`. New code takes both from this module:

```ts
import {
  optionVaultArtifact,
  attestationBeaconArtifact,
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

`vaultProgram()` and `beaconProgram()` load the committed artifacts. `bindContracts` derives the vault a desk quotes. `bindBeacon` derives the beacon from a `beaconIdOf` id. `buildSettle` spends the vault and the beacon together, and `submit` sends that transaction. `slotPrice` is the fixing that vault would accept. `settlePayouts` is what that spend pays.

Programs load the JSON in this directory. The design of the beacon is in [beacon.md](beacon.md).

`option_intent.ark` is the funding coin this deployment fills before a vault exists. The desk spends that coin from its float.

`standing_leg.ark` is the open offer. Side 0 is the writer and does not name a holder. Side 1 is a holder taking that writer's vault. `buildStandingMatch` spends the two coins in one `fill`. Packet 33 on that transaction is the holder's key and payout program. `standing_vault.ark` pays the same amounts as `OptionVault`. The holder is read from that packet. The live sell path does not use these contracts.
