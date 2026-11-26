# COINFLIP

Predict whether Bitcoin closes higher or lower than a line in five minutes. Each prediction is an all-or-nothing contract on Arkade: the stake goes to the desk, and the desk locks the full payout in a vault that only the oracle's committed DIA fixing can settle. Live on Bitcoin mainnet (canary) and Mutinynet.

Forked from [ArkLabsHQ/arkade-options](https://github.com/ArkLabsHQ/arkade-options), which keeps its cash-settled covered calls and limited puts. Predictions are in [Predict](#predict); `pnpm demo` runs the full stack on one machine ([Demo](#demo)).

The contracts are the engine. `PredictVault` (`PredictVaultV3`), `OptionVault`, `OptionIntent`, and `AttestationBeacon` live in [contracts/](contracts/) (see [contracts/README.md](contracts/README.md)) and export through `arkade-options/contracts`.

Day-to-day work is maintaining desk float and monitoring alerts. The stateless Predict oracle streams DIA `BTC/USD` prints and serves one canonical Schnorr-signed fixing per 5-minute close (`GET /api/fixing?expiry=...`) once the close window settles; the settler spends each expired `PredictVaultV3` standalone (1 input, zero read fee). See [docs/mainnet-runbook.md](docs/mainnet-runbook.md) for Bitcoin mainnet operations and [docs/runbook.md](docs/runbook.md) for general bootstrap steps.

## Live (Bitcoin Mainnet Canary)

Deployed as a single hardened Railway container (`coinflip.Dockerfile`) with persistent `/data` storage. Only the page port (`4173`) is public; oracle (`8789`), desk (`8788`), and settler (`8790`) stay on container loopback and are inspected over `railway ssh`.

| | |
| --- | --- |
| Mainnet page | <https://coinflip-mainnet-production.up.railway.app/#/predict> |
| Healthcheck | <https://coinflip-mainnet-production.up.railway.app/demo.json> (minimal status only on mainnet) |
| Mutinynet staging | <https://coinflip-production-57ff.up.railway.app/#/predict> |
| Infrastructure | `arkade.computer`, `emulator.arkade.computer`, `executor.arkade.sh`, `arkade.money` |
| Relay | `wss://nostr.arkade.sh` |

Pinned Bitcoin mainnet beacon & desk identifiers (`BEACON_TXID` is the display `issueTxid`; `ctrlTxid` is reversed byte order as compared in script):

| | |
| --- | --- |
| `issueTxid` / `BEACON_TXID` | `659d1a9b6b73ab12a06a57eae4f57b82dfeb4dfc4f396edd8898f3768fcd83e3` |
| `assetId` | `659d1a9b6b73ab12a06a57eae4f57b82dfeb4dfc4f396edd8898f3768fcd83e30000` |
| `deployTxid` | `2a36d346efc33343c4a22cbafc9f42ce9e0fc3feef9c705d900c14b290dfab6b` |
| `ctrlTxid` | `e383cd8f76f39888dd6e394ffc4debdf827bf5e4ea576aa012ab736b9b1a9d65` |
| Beacon address | `ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamect9lvzlx9f8mngcuw5726v07gcqdhveuceslj8sxjtukzanf8hra6kwf8t` |
| Oracle wallet | `ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameedg84ymwhmeqw4hmn9pcn5mm4xm9d899scsn6x3g05fy9sz0yg5q8da4qw` |
| Oracle `adminPk` | `8fe6e977203e72ed451ac868119134793fb319757e9f902f16ab778d0241bde4` |
| Desk Nostr pubkey | `5e38115019ef7f12437ac8c9aa92205ed937c7c737e9d1c2100fffe104c34ed3` |
| Desk float address | `ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameep3nm53lg5h20n9998yxelutf6pl86d4mr3228tk5jvj5arxmz8sp6c6sf` |
| Tier-2 `BACKUP_EMULATOR_PUBKEY` | `0d81ac7eff0c1d6263ee37ee8e7e966f5a23b6ab4be34184b568e69c140f27c5` |

On Bitcoin mainnet (`NETWORK=bitcoin`), `ORACLE_KEY`, `DESK_KEY`, `ORACLE_ADMIN`, and `BACKUP_EMULATOR_PUBKEY` are mandatory environment variables (fail-closed; keys are never auto-generated or written to `/data/keys.json`). Keeping the `/data` volume across redeploys preserves the beacon, sqlite wallets, quote book, and settler progress.

## Day to day

Inspect internal services on Railway via SSH:

```bash
railway ssh --service coinflip-mainnet -- wget -qO- http://127.0.0.1:8789/api/status
railway ssh --service coinflip-mainnet -- wget -qO- http://127.0.0.1:8788/status
railway ssh --service coinflip-mainnet -- wget -qO- http://127.0.0.1:8790/status
```

- **Balances.** The stateless Predict oracle needs no on-Arkade funding or beacon coin. Desk `balance` is the float available to lock full payouts (`collateral`) for predictions; the desk refuses quotes it cannot cover with `float short`.
- **DIA feed & canonical fixing.** The oracle streams DIA `OracleUpdate` prints for `BTC/USD` and retains 24 hours of sample history (`GET /api/prices?from=<unix>&to=<unix>`) and 48 hours of canonical fixings. Once a print strictly past `expiry + 60` arrives (or a 30-second fallback grace period elapses), `GET /api/fixing?expiry=<unix>` freezes the newest in-window DIA sample in `[expiry, expiry + 60]` and co-signs `predictFixDigest` with `ORACLE_KEY`. Each `PredictVaultV3.settle()` verifies **both** the pinned DIA EIP-712 signature and `oraclePk`'s Schnorr signature directly on the stack (1 input, zero read fee, parallel settlement); anyone can run a settler (`ORACLE_URL=... pnpm settle`) with no keys or fee wallet.
- **Manual admin controls.** Inside the container, `POST /drain?enabled=1|0` on port `8788` and oracle admin routes on port `8789` require `Authorization: Bearer $ORACLE_ADMIN`. All internal service ports (`8788`, `8789`, `8790`) bind to `127.0.0.1` by default. See [docs/mainnet-runbook.md](docs/mainnet-runbook.md) for operational controls and `scripts/backup-refund.ts`.
- **Desk logs.** One line per UTC hour (`hour N quotes, N filled, N premium paid, N collateral locked`), plus immediate logs on fills. Set `DESK_LOG=debug` to log every quote.

## Beacon args

`args` on `/api/status` is the constructor of the live `AttestationBeacon` script (fixed at deploy):

```json
{
  "ctrlTxid": "<issue txid reversed>",
  "domain": "4254435553442d464958",
  "expiryLag": 60,
  "readFee": 1000,
  "adminPk": "<ORACLE_KEY x-only pubkey>",
  "exit": 605184
}
```

| Field | Meaning |
| --- | --- |
| `ctrlTxid` | Identity of the beacon asset as compared in script: display `issueTxid` reversed. Vaults verify input 1 carries one unit of this asset. |
| `domain` | Hex of ASCII `BTCUSD-FIX`, domain-separating `attest`, `migrate`, `reboard`, and `reseed` signatures. |
| `expiryLag` | Seconds after `expiry` before `attest` is allowed (`60`). |
| `readFee` | Sats added to the beacon on every `read` (`1000`, above the 330-sat dust line), paid from vault collateral. |
| `adminPk` | X-only pubkey of `ORACLE_KEY`. Co-signs `attest` (cannot invent prices since DIA's EIP-712 signature is still checked) and signs `migrate`, `reboard`, `reseed`, and `unilateral`. |
| `exit` | Unilateral exit delay in seconds, enforced on startup against `arkd /v1/info` (`605184` / 7 days on Bitcoin mainnet; `2048` on Mutinynet). |

`ctrlGidx` is `0` (the `0000` suffix on `assetId`).

## Predict

All-or-nothing calls on where Bitcoin closes at the end of a 5-minute (or 15-minute) window: higher (kind `2`) or lower (kind `3`) than your strike line. The page route is `#/predict`.

- **Contract (`PredictVaultV3`).** [contracts/predict_vault.ark](contracts/predict_vault.ark) settles standalone (1 input, zero read fee) by verifying both the pinned DIA EIP-712 price signature and `oraclePk`'s Schnorr signature over `sha256("BTCUSD-FIX" || "fix" || expiry || cents || time)` directly on the stack. Above the line (higher) or below it (lower), the holder receives the full `collateral`; an exact tie pays the desk. Three-tier exit/void model:
  - **Tier 1 (Arkade):** `settle(price, time, nonce, intentExpiry, sig, oracleSig)`, `reboard()` (v2 intent proof via `executord` or page), `refund()` after `expiry + 24h` (`voidAfter = 86,400s`), and cooperative 2-of-2 `close()`.
  - **Tier 2 (Bitcoin L1 backup):** `refundBackup(backupSig)` via tweaked `backupPk` after `fallbackDelay` (`605,184s` / 7d on mainnet; `22,016s` / ~6.1h on Mutinynet). Because Bitcoin L1 does not execute the Arkade VM, after `fallbackDelay` the backup key custodian is trusted to sign only valid void refunds (`scripts/backup-refund.ts`).
  - **Tier 3 (Bitcoin L1 mutual):** 2-of-2 `unilateral(writerSig, holderSig)` after `finalExitDelay` (`691,200s` / 8d on mainnet; `108,032s` / ~30h on Mutinynet).
- **Fill & auto-refund.** `OptionIntent` side `1`. The bettor funds the intent with `stake`; the desk `finalize`s by taking `stake` and locking full `collateral` in `PredictVaultV3`. Unfilled stakes can be cancelled after `deadline` via `cancel()` (`OP_CHECKTIME`) or automatically via `executord` (`cancelCltv`).
- **Windows & lines.** Closes sit on the 5-minute grid, 1 to 60 minutes ahead (`PREDICT_MIN_LEFT_S = 30`, `PREDICT_LOCK_S = 30`, 60-second cutoff before close). In `DESK_LINE_MODE=any` (default), bets are always open against live spot lines; set `DESK_LINE_MODE=window` to restrict every bet in a window to the opening DIA sample.
- **Pricing & limits.** Multiplier is `floor(((1 - edge) / p) * 100) / 100` from Deribit ATM IV and the more adverse of DIA spot and Coinbase/Kraken/Binance median (freshly re-fetched and re-checked before fill so adverse moves during the 30s lock cannot snipe the desk). Default `DESK_EDGE = 0.05` (`1.90×` at even odds); multipliers outside `1.05×–10×` or payouts `<= stake` are refused. Mainnet launch defaults: `STAKE_MIN = 10,000`, `STAKE_MAX = 100,000`, `DESK_STRIKE_CAP = 5,000,000`, `DESK_TOTAL_CAP = 20,000,000`, `Q_MAX = 50,000,000` sats (override via `DESK_STAKE_MAX`, `DESK_STRIKE_CAP`, `DESK_TOTAL_CAP`).
- **Delegations & guards.** On mainnet, both desk and page fail closed unless `ORACLE_PUBKEY` matches the live oracle and an independent `BACKUP_EMULATOR_PUBKEY` (distinct from desk, oracle, and primary emulator) is pinned. The desk enforces per-pubkey/global RFQ rate limits and open-quote caps, registers `reboard` delegations on fill, and the page registers `cancel` + `reboard` delegations on placement with `EXECUTOR_URL`.
- **Page & phones.** The page proxies read-only DIA samples (`GET /oracle/prices`) and canonical signed fixings (`GET /oracle/fixing?expiry=...`), emits strict CSP/security headers, supports responsive mobile drawers and standalone home-screen handoff (`/handoff/<id>`), and drops the Mutinynet warning banner on Bitcoin mainnet builds.

## Demo

`pnpm demo` runs the full stack locally against Mutinynet (stateless oracle, desk, settler, and built page) using Node 22.12+ and `pnpm install`:

- Serves the page at <http://127.0.0.1:4173/> (and opens a `trycloudflare.com` quick tunnel if `cloudflared` is installed; pass `--no-tunnel` for local-only, or `--pages` for Cloudflare Pages).
- Walks through funding the desk float via a header pill until live.
- Stores keys, sqlite DBs, and logs in `~/.coinflip-demo` (`COINFLIP_DEMO_DIR` to relocate). Delete the directory to start fresh.

## Deploy

`coinflip.Dockerfile` runs `node scripts/demo.mjs --server` with only port `4173` exposed and persistent storage mounted at `/data`.

### Mutinynet (Railway)

```sh
railway init --name coinflip
railway add --service coinflip --variables PORT=4173 --variables PAGE_PORT=4173 --variables RAILWAY_DOCKERFILE_PATH=coinflip.Dockerfile
railway volume --service coinflip add --mount-path /data
railway domain --service coinflip --port 4173
railway up --service coinflip --ci
```

Mutinynet auto-generates keys into `/data/keys.json` on first start and walks through funding in the UI.

### Bitcoin Mainnet (Railway)

Set `NETWORK=bitcoin`, `PORT=4173`, `PAGE_PORT=4173`, `RAILWAY_DOCKERFILE_PATH=coinflip.Dockerfile`, plus the four mandatory secrets (`ORACLE_KEY`, `DESK_KEY`, `ORACLE_ADMIN`, `BACKUP_EMULATOR_PUBKEY` — keeping `BACKUP_KEY` offline) and optional `ALERT_WEBHOOK_URL`, attach a persistent `/data` volume, and deploy. Full provisioning, funding, renewal, migration, and recovery steps are in [docs/mainnet-runbook.md](docs/mainnet-runbook.md).

## Page

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4173/>. For a static container build:

```bash
docker build -f site.Dockerfile -t coinflip-site .
docker run --rm -p 8080:80 coinflip-site
```

## Check

Unit & integration tests, typecheck, and page build (all enforced in `.github/workflows/check.yml`):

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Go Arkade VM contract tests (including `PredictVaultV3` direct-signature adversarial checks and TS↔Go Taproot parity):

```bash
(cd contracts/go && go test -v ./...)
```

Local Docker regtest end-to-end smoke test (Bitcoin regtest + `arkd` + `emulator`):

```bash
pnpm smoke:regtest
```
