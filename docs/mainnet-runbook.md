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

1. `ORACLE_KEY` — 64-hex private key for the stateless oracle (`PredictVault.oraclePk`), which co-signs canonical DIA fixings via BIP340 Schnorr. Holds no Arkade wallet or funds.
2. `DESK_KEY` — 64-hex private key for the desk Nostr identity & float wallet (must differ from `ORACLE_KEY`).
3. `ORACLE_ADMIN` — random bearer token (`>= 16` chars) protecting oracle `/api/intent` and desk `/drain` (unless `DESK_ADMIN` is set separately).
4. `BACKUP_EMULATOR_PUBKEY` — 64-hex x-only public key of an **independent** Tier-2 backup keypair (must differ from `DESK_KEY`, `ORACLE_KEY`, and `emulator.arkade.computer`). Keep the corresponding `BACKUP_KEY` offline / separate from the server.

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

Optional overrides: `DESK_ADMIN`, `DESK_STAKE_MAX`, `DESK_STRIKE_CAP`, `DESK_TOTAL_CAP`, `DESK_DRAIN`, `DESK_LINE_MODE` (`any` or `window`), `DESK_EDGE`, `DESK_VOL`.

Startup sequence:
1. Deploy the service. `/demo.json` returns `{ "ok": true, "network": "bitcoin", "stage": "..." }` (setup wizard and wallet balances are not exposed publicly on mainnet).
2. Verify the stateless oracle is streaming DIA prices via `railway ssh -- wget -qO- http://127.0.0.1:8789/api/status` (no wallet funding needed).
3. Inspect the desk funding address via `railway ssh -- wget -qO- http://127.0.0.1:8788/status` and fund the canary float (e.g., 1,000,000–5,000,000 sats).
4. Place one minimum-size (10,000 sats) canary prediction end-to-end and verify fill, canonical fixing (`GET /api/fixing?expiry=<unix>`), and automatic settlement.

## 4. Routine Maintenance

### A. Graceful Drain & Redeploy

Before rotating keys or performing maintenance on the desk:

1. Enable graceful drain (stops quoting new bets while letting live quotes and vaults settle):
   ```bash
   curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" "http://127.0.0.1:8788/drain?enabled=1"
   ```
2. Wait until `quoteCounts.live == 0` on `http://127.0.0.1:8788/status` and all open vaults have settled on `http://127.0.0.1:8790/status`.
3. Perform maintenance / deploy, then re-enable quoting:
   ```bash
   curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" "http://127.0.0.1:8788/drain?enabled=0"
   ```

### B. Unfixed Windows (Void Refund)

If DIA fails to emit any `BTC/USD` update within `[expiry, expiry + 60]` (or the oracle cannot produce a fixing), `PredictVault.settle()` cannot execute. After `expiry + voidAfter` (24 hours), the settler automatically invokes `PredictVault.refund()` (returning `stake` to the bettor and `collateral - stake` to the desk), or anyone can trigger **Void & refund stake** from the position page.

### C. Tier-2 Emergency Recovery (`PredictVault.refundBackup`)

If the Arkade server/emulator is permanently unreachable after `fallbackDelay` (7 days) and `expiry + voidAfter` (24h), the holder can unroll the vault on-chain and the independent backup key custodian signs the Tier-2 refund transaction:

```bash
NETWORK=bitcoin BACKUP_KEY=<offline-64-hex> POSITION_FILE=position.json \
  UTXO_TXID=<onchain-txid> UTXO_VOUT=0 UTXO_VALUE=<sats> FEE_SATS=1000 \
  node --experimental-strip-types scripts/backup-refund.ts
```

Broadcast `rawTxHex` to Bitcoin L1 once both `lockTime` (`expiry + voidAfter`) and CSV `sequence` (`fallbackDelay`) are satisfied.

> **Tier-2 trust model disclosure:** Bitcoin L1 cannot evaluate Arkade VM scripts, so after `fallbackDelay` (7 days) the `refundBackup` tapscript leaf checks only `older(fallbackDelay)` and a signature from the script-tweaked `BACKUP_EMULATOR_PUBKEY`. `scripts/backup-refund.ts` signs with that plain backup private key. That key is therefore a single trusted recovery key after 7 days: the page verifies only that it differs from the desk and primary emulator keys, and users trust the independent custodian (Ark Labs for the canary) to sign only valid void refunds.
