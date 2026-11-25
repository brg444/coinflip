# COINFLIP Bitcoin Mainnet Runbook

## 1. Mainnet Infrastructure & Defaults

Setting `NETWORK=bitcoin` selects the Bitcoin mainnet profile in `protocol/network.ts`:

| Parameter | Mainnet Value | Notes |
| :--- | :--- | :--- |
| `ARK_URL` | `https://arkade.computer` | Verified against `/v1/info` (`network: "bitcoin"`, HRP `ark`) |
| `EMULATOR_URL` | `https://emulator.arkade.computer` | Pinned key `BITCOIN_EMULATOR_PUBKEY` (`0239c196…092e`) |
| `EXECUTOR_URL` | `https://executor.arkade.sh` | Auto-cancel (`OptionIntent.cancelCltv`) & auto-reboard (`PredictVault.reboard`) |
| `WALLET_URL` | `https://arkade.money` | Mainnet Arkade wallet |
| `EXPLORER_TX_URL` | `https://explorer.arkade.sh/tx/` | Mainnet Arkade explorer |
| `EXIT` (`unilateralExitDelay`) | `605,184s` (7 days) | Enforced on startup against `arkd /v1/info` |
| `PredictVault` Tier 2 / Tier 3 | `fallbackDelay=605,184s` (7d), `finalExitDelay=691,200s` (8d), `voidAfter=86,400s` (24h) | All CSV leaves `>= unilateralExitDelay` |
| Launch Risk Limits | `STAKE_MIN=10,000`, `STAKE_MAX=100,000`, `DESK_STRIKE_CAP=5,000,000`, `DESK_TOTAL_CAP=20,000,000`, `Q_MAX=50,000,000` sats | `Q_MAX` matches mainnet `vtxoMaxAmount` (0.5 BTC); override `DESK_STAKE_MAX` / caps via env |

## 2. Mandatory Mainnet Secrets (Fail-Closed)

On `NETWORK=bitcoin`, `scripts/demo.mjs` refuses to auto-generate keys and exits unless all four secrets are supplied via encrypted environment variables:

1. `ORACLE_KEY` — 64-hex private key for the oracle wallet & `AttestationBeacon.adminPk`.
2. `DESK_KEY` — 64-hex private key for the desk Nostr identity & float wallet (must differ from `ORACLE_KEY`).
3. `ORACLE_ADMIN` — random bearer token (`>= 16` chars) protecting oracle admin endpoints and desk `/drain`.
4. `BACKUP_EMULATOR_PUBKEY` — 64-hex x-only public key of an **independent** Tier-2 backup keypair (must differ from both `DESK_KEY` and `emulator.arkade.computer`). Keep the corresponding `BACKUP_KEY` offline / separate from the server.

Generate fresh independent keys locally (never commit or log them):

```bash
openssl rand -hex 32   # ORACLE_KEY
openssl rand -hex 32   # DESK_KEY
openssl rand -hex 24   # ORACLE_ADMIN
openssl rand -hex 32   # BACKUP_KEY (keep offline; derive 64-hex x-only pubkey for BACKUP_EMULATOR_PUBKEY)
```

## 3. Initial Provisioning (Dedicated Railway Service)

Keep the existing Mutinynet Railway service untouched. Provision a separate mainnet service pointing at `coinflip.Dockerfile` with a persistent `/data` volume and env vars:

```text
NETWORK=bitcoin
PAGE_PORT=4173
ORACLE_KEY=<secret>
DESK_KEY=<secret>
ORACLE_ADMIN=<secret>
BACKUP_EMULATOR_PUBKEY=<64-hex x-only pubkey>
```

Optional overrides: `DESK_STAKE_MAX`, `DESK_STRIKE_CAP`, `DESK_TOTAL_CAP`, `DESK_DRAIN`, `BEACON_RENEW_BEFORE_S` (default `432000` / 5 days on mainnet), `ALERT_WEBHOOK_URL` (optional webhook for `[ALERT]` notifications on renewal failure or upcoming `deprecatedSigners` cutoff).

Startup sequence:
1. Deploy the service. `/demo.json` returns `{ "ok": true, "network": "bitcoin", "stage": "..." }` (setup wizard and wallet balances are not exposed publicly on mainnet).
2. Inspect the oracle funding address via `railway ssh -- wget -qO- http://127.0.0.1:8789/api/status` and fund it with ~50,000 mainnet sats. The service automatically issues the 1-unit beacon asset and deploys `AttestationBeacon`.
3. Inspect the desk funding address via `railway ssh -- wget -qO- http://127.0.0.1:8788/status` and fund the canary float (e.g., 1,000,000–5,000,000 sats).
4. Place one minimum-size (10,000 sats) canary prediction end-to-end and verify fill, `attest`, and automatic settlement.

## 4. Routine Maintenance

### A. Beacon 30-Day Batch Renewal (`reboard` + `reseed`)

**Automated renewal (default):** `scripts/demo.mjs` runs `scripts/beacon-renewal.mjs` every 15 minutes. When `beaconExpiry - now <= BEACON_RENEW_BEFORE_S` (default 5 days on mainnet, and inside mainnet's `<= 29` day free renewal window):

1. It enables graceful drain on the desk (`POST /drain?enabled=1`, preserving any pre-existing manual drain).
2. It waits (up to 70 minutes) until `quoteCounts.live == 0` and all filled vaults settle. `POST /api/renew` also enforces this directly and refuses with `409 live vault open` while any filled position's vault VTXO is still unspent on the indexer (so recorded prices are never blanked while a vault still needs them).
3. It renews and reseeds the beacon (`POST /api/renew`), preserving `BEACON_TXID`, incrementing `round`, and preserving monotonic `lastExpiry`.
4. It always re-enables quoting (`POST /drain?enabled=0`) in `finally` if it enabled drain, and emits `[ALERT]` logs (plus an optional `ALERT_WEBHOOK_URL` POST) if renewal fails, `beaconExpiry == 0`, or an `arkd` `deprecatedSigners` cutoff is within 7 days.

**Manual fallback:** If an alert fires or you need to renew manually:

1. Enable graceful drain:
   ```bash
   curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" "http://127.0.0.1:8788/drain?enabled=1"
   ```
2. Wait until `quoteCounts.live == 0` on desk `/status` and all open vaults have settled.
3. Renew and reseed the beacon:
   ```bash
   curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:8789/api/renew
   ```
4. Re-enable quoting:
   ```bash
   curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" "http://127.0.0.1:8788/drain?enabled=0"
   ```

### B. Contract Upgrade or `arkd` Server Key Rotation (`deprecatedSigners`)

Monitor `deprecatedSigners` on `http://127.0.0.1:8789/api/status`. Before any `cutoffDate` (or before deploying a new `AttestationBeacon` artifact):

1. Drain the desk (`POST /drain?enabled=1`) and wait for all open positions to settle.
2. Deploy the new code (for contract upgrades) and run:
   ```bash
   NETWORK=bitcoin OLD_ARTIFACT=/path/to/prev.artifact.json \
     node --experimental-strip-types scripts/migrate-beacon.ts
   ```
   For server-key rotation with the same artifact, pass `OLD_SERVER_KEY=<64-hex deprecated pubkey>`.
3. Verify `beaconExpiry > 0` on both oracle and desk `/status`, then disable drain (`POST /drain?enabled=0`).

### C. Tier-2 Emergency Recovery (`PredictVault.refundBackup`)

If the Arkade server/emulator is permanently unreachable after `fallbackDelay` (7 days) and `expiry + voidAfter` (24h), the holder can unroll the vault on-chain and the independent backup key custodian signs the Tier-2 refund transaction:

```bash
NETWORK=bitcoin BACKUP_KEY=<offline-64-hex> POSITION_FILE=position.json \
  UTXO_TXID=<onchain-txid> UTXO_VOUT=0 UTXO_VALUE=<sats> FEE_SATS=1000 \
  node --experimental-strip-types scripts/backup-refund.ts
```

Broadcast `rawTxHex` to Bitcoin L1 once both `lockTime` (`expiry + voidAfter`) and CSV `sequence` (`fallbackDelay`) are satisfied.

> **Tier-2 trust model disclosure:** Bitcoin L1 cannot evaluate Arkade VM scripts, so after `fallbackDelay` (7 days) the `refundBackup` tapscript leaf checks only `older(fallbackDelay)` and a signature from the script-tweaked `BACKUP_EMULATOR_PUBKEY`. `scripts/backup-refund.ts` signs with that plain backup private key. That key is therefore a single trusted recovery key after 7 days: the page verifies only that it differs from the desk and primary emulator keys, and users trust the independent custodian (Ark Labs for the canary) to sign only valid void refunds.
