# Attestation beacon

A committee-signed registry that a covenant reads by spending it in the same transaction. The option vault is the first consumer. The shape is the LayerZero endpoint from the compiler examples: a verifier coin identified by an asset, consumers that read its packet.

Contracts: `attestation_beacon.ark`, `option_vault.ark`. Open checks are at the end.

## 1. What an oracle has to give a covenant

A covenant runs inside one transaction. It sees inputs, outputs, packets, and whatever the spender puts on the stack. Anything it cannot verify inside that transaction is trust in the spender. So a price arrives in one of three forms:

1. Signed data on the stack. The covenant verifies signatures against keys baked into its own script. The previous `option_vault.ark` did this: nine `checkSigFromStack` over three slices, five committee keys as constructor parameters. That welds the committee to every vault ever created. Rotating one key leaves every open vault on the old one.
2. A committed value in the covenant's own state. Only for values known at creation.
3. Data on another input of the same transaction, whose provenance the covenant can check. The verification lives in that other coin's script. The consumer answers one question: is this input the oracle?

Form 3 is the endpoint pattern. Two Arkade rules make the provenance check cheap:

- Asset provenance is arkd's job, not a script's. `pkg/ark-lib/asset/tx_validation.go` rejects a reissuance of an asset that has no control asset, derives an issuance id from the transaction that creates it, and requires every asset on a spent input to appear in the packet with its real amount. An asset issued once, uncontrolled, with supply 1 exists as exactly one unit until it is burned, and every transaction that moves it is one arkd validated against the previous coin's script.
- `tx.inputs[i].packet(type)` reads an extension packet from the transaction that created input `i`. A coin's state is that packet. A covenant that requires the next packet to be a legal successor of the previous one turns the state into a chain.

Identity is an asset unit, state is a packet, and the covenant holding the unit is the only cooperative path that advances the packet. A consumer that finds the unit on an input has found the oracle, whatever script holds it today.

## 2. Design

### Identity

`AttestationBeacon(ctrlTxid, ctrlGidx, signers, signersN, threshold, domain, expiryLag, readFee, adminPk, exit)`. The beacon coin carries one unit of the asset `(ctrlTxid, ctrlGidx)`. The vault commits to `(beaconTxid, beaconGidx)` and to `readFee`. The service deploys 330 sats and sets `readFee` to 1000, above the dust line. One to five oracle keys sign each sample, and `threshold` of them must agree. `adminPk` does not sign prices. It migrates the coin and takes the unilateral exit.

The script cannot see the issuance. The desk trusts the asset id it is given (see §4, a second identity unit).

### State

Packet type 32 in the creating transaction. 329 bytes:

| offset | size | field |
| --- | --- | --- |
| 0 | 1 | version, `0x01` |
| 1 | 8 | round, `num2bin(round, 8)` |
| 9 + 40·n | 40 | slot n, n = 0..7, newest first: expiry `num2bin(expiry, 8)`, value 32 bytes |

Genesis is round 0 with eight zero slots. For the option vault that field is the expiry, the time the price belongs to. The 32-byte value keeps the price in the first 8 bytes and the sample time in the next 8. The remaining 16 bytes are zero. The vault reads the price from the first 8 bytes and rejects a sample time outside `[expiry, expiry + 60]`.

The packet is one stack element. `OP_INSPECTINPUTPACKET` rejects more than 520 bytes, so 9 + 40·n ≤ 520 gives at most 12 slots. Past that the state must become a Merkle root.

### Leaves

`attest(expiry, price, time, sigs)`. Beacon at input 0. `expiry` is the time the price belongs to. The oracle message is `sha256(ctrlTxid || 0x425443555344 || num2bin(expiry, 8) || num2bin(price, 8) || num2bin(time, 8))`. The first `signersN` keys are checked and `threshold` of them must verify. A signature names one expiry, so a print cannot be written into a later slot, and a one-cent change of the price does not verify. `expiry > 1800` and that expiry is not already in a slot. The sample time must satisfy `expiry <= time <= expiry + expiryLag`. When `expiryLag ≥ 0`, the emulator clock must have reached `expiry + expiryLag`. A price beacon sets 60, so a fixing cannot be published before its minute closes, and a print from before that minute cannot fill the slot. The stored value is `num2bin(price, 8) || num2bin(time, 8) || num2bin(0, 16)`. The new packet has round + 1, slot 0 = (expiry, price || time), slots 1..7 = old slots 0..6. Output 0 keeps the script, at least the value, and the asset unit.

An expiry that falls off the eight slots may be written again only with the same price and time. The message names the expiry, so a different price or time does not verify. The oracle service signs one fixing per expiry and reuses that pair. `adminPk` does not sign the sample. It is the key for `migrate` and the unilateral exit.

`read(selfIndex)`. `selfIndex` is the beacon's own input index. The current transaction carries a packet equal to the beacon's own. Output 0 keeps the script and the asset unit, and is worth at least the input plus `readFee`. The live service sets `readFee` to 1000. The vault pays that out of its collateral. No signature: anyone may read. A read pins nothing else about its transaction: not the number of inputs, not who else is in it.

`migrate(next, opSig)`. Beacon at input 0. Callers pass `next` as `ScriptPubKey { program, version: 1 }`, not a bare 32-byte program. `adminPk` signs `sha256(domain + "migrate" + ctrlTxid + num2bin(ctrlGidx, 4) + num2bin(round, 8) + next.program)`, with `round` read from the current packet, so a migrate signature is good for one state only. Output 0 pays that script with the asset unit and at least the value; the packet is carried unchanged. The consumer does not change.

`committee` checks `1 ≤ threshold ≤ signersN ≤ 5` and that the live signer keys differ. It runs from `attest` only. `migrate` is `adminPk` alone.

`unilateral(adminSig)` tapscript. `older(exit)` and the admin key.

### Consumer: `OptionVault`

`oracles[5]` is not a parameter. The vault commits to `(beaconTxid, beaconGidx)`. `settle()` takes no witness. It requires the emulator clock at or past `expiry`, itself at input 0, at least two inputs, one unit of the identity asset on input 1, and reads `tx.inputs[1].packet(32)`. The newest slot for that expiry gives the price in the first 8 bytes of the value and the sample time in the next 8. The time must sit in `[expiry, expiry + 60]`, the same window `attest` enforces when `expiryLag` is 60. The desk refuses a quote when the live beacon's `expiryLag` is not 60, so a vault is never built against a different window. Payoff and dust folding pay outputs 1 and 2; output 0 belongs to the beacon. An expiry of 0 matches only empty slots, whose price 0 then fails `st > 0`.

`close` and `unilateral` are unchanged.

### Transaction layouts

Attest:

```
in 0  beacon (attest)            out 0  beacon, same script, ≥ 330 sats, 1 unit
                                 out 1  extension: asset packet, state packet, emulator packet
                                 out 2  anchor
```

Settle:

```
in 0  vault (settle)             out 0  beacon, same script, same sats, 1 unit
in 1  beacon (read, selfIndex 1) out 1  holder or writer leg
                                 out 2  writer leg, when both legs are above dust
                                 out 3  extension: asset packet, state packet copy, emulator packet with two entries
                                 out 4  anchor
```

### Relation to the LayerZero example

| LayerZero / USDT0 example | here |
| --- | --- |
| Endpoint state coin with control asset | beacon coin with identity asset |
| DVN 2-of-2 over the attested hash | `threshold` of the oracle keys over `sha256(ctrlTxid \|\| BTCUSD \|\| expiry \|\| price \|\| time)` |
| OApp reads the marker's previous packet | vault reads the beacon's previous packet |
| Marker minted per message and burned by the consumer | the beacon itself is co-spent and continued |
| DVN config change by the owner | `migrate` by `adminPk` |
| inbound nonce | expiry |

The beacon is a reusable attestation registry, not a drop-in endpoint. An OApp built on it must carry the message body on its own stack and hash-match it to the 32-byte slot value, keep its own inbound-nonce state for exactly-once consumption (the beacon consumes nothing, so two spends can read one expiry), and consume each expiry while it is in a slot. It does not replace the example's marker, which transports the body and burns once. What it gives an OApp is the same thing it gives the vault: the verifier set changes without touching the consumer.

The marker design was not taken here because a marker unit can be re-homed by whoever spends it unless the marker script forbids every spend but a burn inside a known consumer, which pins the consumer's closure hash into the oracle, the coupling this design removes.

## 3. What each layer enforces

Script, `attestation_beacon.ark`:

- `threshold` oracle signatures over `sha256(ctrlTxid || BTCUSD || expiry || price || time)`. Sample time in `[expiry, expiry + expiryLag]`. Round + 1. Expiry above 1800 and absent from the current slots. Clock past `expiry + expiryLag` when `expiryLag ≥ 0`. Slot value is the price in the first 8 bytes, the sample time in the next 8, then zeros. History shift of 280 bytes. Continuation of script, value, and asset unit on output 0. Attest and migrate at input 0. A read carries the packet unchanged and adds `readFee` (1000). `migrate` needs `adminPk`. An evicted expiry verifies again only for that same price and time.

Script, `option_vault.ark`:

- Vault at input 0. Identity asset on input 1. Packet version and size. A slot for `expiry`, newest wins. Price in `1..1,000,000,000`. Sample time in `[expiry, expiry + 60]`. Clock at or past `expiry`. Payoff, dust, output scripts, output values.

arkd, `pkg/ark-lib/asset/tx_validation.go`:

- Every asset on a spent input appears in the packet with the right amount. An uncontrolled asset is never reissued. `assets.lookup` in a script reads the packet's claims; arkd is what ties those claims to real prevouts.

Emulator:

- Runs both covenants of a settle transaction, one per emulator entry. Resolves `tx.inputs[1].packet` from the previous Arkade transaction attached to input 1. Supplies the wall clock for `checkTime`.

## 4. Threats

| attempt | outcome |
| --- | --- |
| Consumer supplies a packet with a different price | blocked: `read` requires `tx.packet(32) == tx.inputs[selfIndex].packet(32)`; the vault reads the input packet anyway. |
| Consumer claims a different asset is the beacon | blocked: vault `tx.inputs[1].assets.lookup(beaconTxid, beaconGidx) == 1`; arkd checks the claim against the prevout. |
| A second identity unit | blocked by arkd only if the issuance was uncontrolled with supply 1. The oracle service issues with `assetManager.issue({ amount: 1n })` and no control asset. The script cannot see the issuance, and the desk trusts `BEACON_TXID` as given. |
| Committee attests the same expiry twice while it is in a slot | blocked: `absent`. |
| A fixing is evicted before a vault settles | recoverable with the same price and time. A different price or time does not verify. |
| Fixing published before the settlement minute closes | blocked when `expiryLag ≥ 0`: `checkTime(expiry + expiryLag)`. |
| A print from before its expiry written into that slot | blocked: `time >= expiry`, and the signature names the expiry. |
| A published signature reused for a later expiry | blocked: the message names the expiry. |
| Consumer attaches a forged previous transaction for input 1 | not blocked by any script. The VM's `OP_INSPECTINPUTPACKET` takes the previous transaction from its fetcher without comparing a hash; the compiler's test harness maps it by outpoint with no check, and a probe against that harness accepted a forged previous transaction. Whether the emulator service binds the attached transaction to the input, through the checkpoint hop, is unverified here. Everything that reads a previous packet, this design and the LayerZero example alike, rests on it. |
| Two settlements race for the beacon | one is rejected and rebuilt on the new outpoint. Bounded, not impossible. |
| Someone reads the beacon to move it | costs `readFee` per read. The service sets that to 1000, above dust and paid by the vault, and the sats stay on the beacon. Each read still lengthens the beacon's off-chain ancestry. |
| Oracle prints replayed on another beacon | blocked: the digest names `ctrlTxid`. |
| Old migrate signatures replayed | blocked: the digest names the round. |
| Migrate to a script that lies | needs `adminPk`. That is the trust a consumer accepts by committing to the asset id. |
| Layout version bumped while vaults are open | not blocked. An old vault's `settle` fails, `close` needs both parties, and the writer's `unilateral` then takes the whole coin after the CSV. Do not bump the version while vaults bound to the old layout are open. |
| Admin exits the coin to Bitcoin | the unit leaves Arkade. Whether an on-chain unit can re-enter as an asset claim is unverified here. |

Not claimed: committee honesty, committee liveness, hidden prices, settlement without arkd, any bound on how late a fixing is published.

The signature is checked inside `attest`. What stays off-chain is whether the signed price matches the market.

## 5. Checked

Both contracts compile with `arkadec` 0.1.0-rc.1. It warns that `OptionVault.settle` inspects `tx.outputs[1].script` more than once, and that `AttestationBeacon.attest` uses `checkSigFromStack` where an invalid signature fails the spend. The artifacts are committed. `AttestationBeacon.attest` has 5 `CHECKSIGFROMSTACK`. `OptionVault.settle` has no `CHECKSIGFROMSTACK`, one `INSPECTINASSETLOOKUP`, one `INSPECTINPUTPACKET`, and checks the stored sample time.

`pnpm test` covers the state codec, the artifacts, the bindings, the deploy outputs, the oracle service, and the layout of the transactions `cospend.ts` builds.

Signatures from a beacon deployed before this binding do not verify. Mutinynet needs a new beacon after the change. Old vaults are bound to the previous vault script, which does not check the stored sample time.

## 6. Implementation

An Arkade transaction's inputs spend checkpoint outputs, not the coins themselves. `tx.input.current.script` and `tx.inputs[i].packet` reach the coin through the previous Arkade transaction attached to the input, which is what the continuation and the packet read rely on. The deploy is not a covenant spend; it goes through the wallet's `buildAndSubmitOffchainTx`.

The desk and the page bind `OptionVault` to the beacon id they are given (`BEACON_TXID` on the desk, `beacon_txid` on the quote). `messages.ts` does not yet refuse expiries off the daily 08:00 UTC grid, so one-off expiries can fill the eight slots.

## 7. Verify before mainnet

- The emulator service binds the attached previous transaction of each input to that input, across the checkpoint hop. Submit a settle with a forged previous transaction to Mutinynet and require rejection.
- Asset claims are rejected on boarding inputs and on any input whose prevout is not an Arkade transaction output.
- An asset-bearing coin survives a batch refresh, and which spend does it. `read` at input 0 is the intended renewal shape. Server key rotation (`deprecatedSigners` in `/v1/info`) needs a `migrate` to a script with the new server key before each cutoff.
- A two-covenant settle with no user-signed input is accepted by `RestEmulatorProvider.submitTx`. The earlier Mutinynet settle also carried a fee coin, because that script charged `readFee`.
- Operator rate limits on `read`, and the measured exit chain length after N reads.
