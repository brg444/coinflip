# Attestation beacon

A price registry that a covenant reads by spending it in the same transaction. The option vault is the first consumer. The shape is the LayerZero endpoint from the compiler examples: a verifier coin identified by an asset, consumers that read its packet.

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

`AttestationBeacon(ctrlTxid, ctrlGidx, domain, expiryLag, readFee, adminPk, exit)`. The beacon coin carries one unit of the asset `(ctrlTxid, ctrlGidx)`. The vault commits to `(beaconTxid, beaconGidx)` and to `readFee`. The service deploys 330 sats and sets `readFee` to 1000, above the dust line. `attest` checks one pinned DIA secp256k1 key over the BTC/USD EIP-712 digest. `adminPk` does not sign prices. It migrates the coin and takes the unilateral exit.

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

`attest(expiry, price, time, nonce, intentExpiry, sig)`. Beacon at input 0. `expiry` is the option expiry, the slot key. `price` is the DIA 18-decimal integer. The script divides by 10^16, rounds half up, and stores those cents. `time` is the DIA timestamp and must satisfy `expiry <= time <= expiry + expiryLag`. `sig` is the 64-byte `r || s` checked with `checkSigFromStack` against the pinned DIA key over `digest(0x1901 || domainSeparator || structHash, 4)`. `expiry > 1800` and that expiry is not already in a slot. When `expiryLag ≥ 0`, the emulator clock must have reached `expiry + expiryLag`. A price beacon sets 60. The stored value is `num2bin(cents, 8) || num2bin(time, 8) || num2bin(0, 16)`. The new packet has round + 1, slot 0 = (expiry, cents || time), slots 1..7 = old slots 0..6. Output 0 keeps the script, at least the value, and the asset unit.

An expiry that falls off the eight slots can be written again with any DIA intent whose timestamp still sits in that window. The service keeps the first intent it published for that expiry and reuses it. A sample stored before this upgrade has no DIA price, nonce, intent expiry, or signature, so it cannot be published. `adminPk` does not sign the sample. It is the key for `migrate` and the unilateral exit.

`read(selfIndex)`. `selfIndex` is the beacon's own input index. The current transaction carries a packet equal to the beacon's own. Output 0 keeps the script and the asset unit, and is worth at least the input plus `readFee`. The live service sets `readFee` to 1000. The vault pays that out of its collateral. No signature: anyone may read. A read pins nothing else about its transaction: not the number of inputs, not who else is in it.

`migrate(next, opSig)`. Beacon at input 0. Callers pass `next` as `ScriptPubKey { program, version: 1 }`, not a bare 32-byte program. `adminPk` signs `sha256(domain + "migrate" + ctrlTxid + num2bin(ctrlGidx, 4) + num2bin(round, 8) + next.program)`, with `round` read from the current packet, so a migrate signature is good for one state only. Output 0 pays that script with the asset unit and at least the value; the packet is carried unchanged. The consumer does not change.

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
| DVN 2-of-2 over the attested hash | one pinned DIA key over the BTC/USD EIP-712 digest |
| OApp reads the marker's previous packet | vault reads the beacon's previous packet |
| Marker minted per message and burned by the consumer | the beacon itself is co-spent and continued |
| DVN config change by the owner | `migrate` by `adminPk` |
| inbound nonce | expiry |

The beacon is a reusable attestation registry, not a drop-in endpoint. An OApp built on it must carry the message body on its own stack and hash-match it to the 32-byte slot value, keep its own inbound-nonce state for exactly-once consumption (the beacon consumes nothing, so two spends can read one expiry), and consume each expiry while it is in a slot. It does not replace the example's marker, which transports the body and burns once. What it gives an OApp is the same thing it gives the vault: the verifier set changes without touching the consumer.

The marker design was not taken here because a marker unit can be re-homed by whoever spends it unless the marker script forbids every spend but a burn inside a known consumer, which pins the consumer's closure hash into the oracle, the coupling this design removes.

## 3. What each layer enforces

Script, `attestation_beacon.ark`:

- One DIA signature over the BTC/USD EIP-712 digest. The script rebuilds that digest from the witness price, timestamp, nonce, and intent expiry, with chain id 1050 and symbol `BTC/USD` fixed. It scales the 18-decimal price to cents. Sample time in `[expiry, expiry + expiryLag]`. Round + 1. Expiry above 1800 and absent from the current slots. Clock past `expiry + expiryLag` when `expiryLag ≥ 0`. Slot value is the cents in the first 8 bytes, the sample time in the next 8, then zeros. History shift of 280 bytes. Continuation of script, value, and asset unit on output 0. Attest and migrate at input 0. A read carries the packet unchanged and adds `readFee` (1000). `migrate` needs `adminPk`. An evicted expiry can take any later intent still inside its window.

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
| The same expiry attested twice while it is in a slot | blocked: `absent`. |
| A fixing is evicted before a vault settles | the service republishes the intent it stored. The script also accepts another intent whose timestamp is still in the window. |
| Fixing published before the settlement minute closes | blocked when `expiryLag ≥ 0`: `checkTime(expiry + expiryLag)`. |
| A print from before its expiry written into that slot | blocked: `time >= expiry`. |
| One DIA print written into an expiry more than 60 seconds away | blocked: `time` must sit in `[expiry, expiry + expiryLag]`. |
| Consumer attaches a forged previous transaction for input 1 | blocked in `arkade-os/emulator` v0.0.10, which fetches the creating virtual tx from `arkd` and validates the input outpoint binding across the checkpoint hop (earlier compiler test harnesses did not verify the outpoint hash). |
| Two settlements race for the beacon | one is rejected and rebuilt on the new outpoint. Bounded, not impossible. |
| Someone reads the beacon to move it | costs `readFee` per read. The service sets that to 1000, above dust and paid by the vault, and the sats stay on the beacon. Each read still lengthens the beacon's off-chain ancestry. |
| The same DIA print attested on another beacon | the digest does not name `ctrlTxid`. The price is the public DIA print. A consumer trusts the asset id it was given. |
| Old migrate signatures replayed | blocked: the digest names the round. |
| Migrate to a script that lies | needs `adminPk`. That is the trust a consumer accepts by committing to the asset id. |
| Layout version bumped while vaults are open | not blocked. An old vault's `settle` fails, `close` needs both parties, and the writer's `unilateral` then takes the whole coin after the CSV. Do not bump the version while vaults bound to the old layout are open. |
| Admin exits the coin to Bitcoin | the unit leaves Arkade. Whether an on-chain unit can re-enter as an asset claim is unverified here. |

Not claimed: that every authorized DIA signer can publish (only the pinned key verifies), hidden prices, settlement without arkd, any bound on how late a fixing is published.

The signature is checked inside `attest`. What stays off-chain is whether the signed price matches the market.

## 5. Checked

All contracts compile with `@arkade-os/compiler` 0.1.0 with zero unexplained diagnostics (`int2bytes`/`bytes2int`, `AssetId`, single-inspection output script bindings, and `@allow` annotations on intentional covenant paths). The artifacts are committed. `AttestationBeacon.attest` has one `CHECKSIGFROMSTACK`, two `DIGEST`, one `DIV`, and one `MOD`. `OptionVault.settle` has no `CHECKSIGFROMSTACK`, one `INSPECTINASSETLOOKUP`, one `INSPECTINPUTPACKET`, and checks the stored sample time.

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
