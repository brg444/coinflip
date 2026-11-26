# COINFLIP

Predict whether Bitcoin closes higher or lower than a line in five minutes. Each prediction is an all-or-nothing contract on Arkade: the stake goes to the desk, and the desk locks the full payout in a standalone `PredictVault` (`PredictVaultV3`) that settles directly via dual `checkSigFromStack` verification (the pinned DIA EIP-712 price update + the oracle's BIP340 Schnorr canonical fixing signature) with zero read fee and no on-chain beacon.

Originally derived from [ArkLabsHQ/arkade-options](https://github.com/ArkLabsHQ/arkade-options). `pnpm demo` runs the full stack on one machine ([Demo](#demo)).

The contracts are the engine. `PredictVault` (`PredictVaultV3`) and `OptionIntent` live in [contracts/](contracts/) (see [contracts/README.md](contracts/README.md)) and export through `coinflip/contracts`.

Day-to-day work is maintaining desk float. The stateless oracle streams DIA `BTC/USD` prints and co-signs one canonical fixing per 5-minute close (`GET /api/fixing?expiry=<unix>`); the settler spends each expired vault directly with that signed fixing (or triggers `refund()` after the 24h void window). See [docs/mainnet-runbook.md](docs/mainnet-runbook.md) for Bitcoin mainnet operations.

## Live (Bitcoin Mainnet Canary)

Deployed as a single hardened Railway container (`coinflip.Dockerfile`) with persistent `/data` storage. Only the page port (`4173`) is public; oracle (`8789`), desk (`8788`), and settler (`8790`) stay on container loopback and are inspected over `railway ssh`.

| | |
| --- | --- |
| Mainnet page | <https://coinflip-mainnet-production.up.railway.app/#/predict> |
| Healthcheck | <https://coinflip-mainnet-production.up.railway.app/demo.json> (minimal status only on mainnet) |
| Mutinynet staging | <https://coinflip-production-57ff.up.railway.app/#/predict> |
| Infrastructure | `arkade.computer`, `emulator.arkade.computer`, `executor.arkade.sh`, `arkade.money` |
| Relay | `wss://nostr.arkade.sh` |

Pinned Bitcoin mainnet oracle & desk identifiers:

| | |
| --- | --- |
| Oracle `oraclePk` | `8fe6e977203e72ed451ac868119134793fb319757e9f902f16ab778d0241bde4` |
| Desk Nostr pubkey | `5e38115019ef7f12437ac8c9aa92205ed937c7c737e9d1c2100fffe104c34ed3` |
| Desk float address | `ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameep3nm53lg5h20n9998yxelutf6pl86d4mr3228tk5jvj5arxmz8sp6c6sf` |
| Tier-2 `BACKUP_EMULATOR_PUBKEY` | `0d81ac7eff0c1d6263ee37ee8e7e966f5a23b6ab4be34184b568e69c140f27c5` |

On Bitcoin mainnet (`NETWORK=bitcoin`), `ORACLE_KEY`, `DESK_KEY`, `ORACLE_ADMIN`, and `BACKUP_EMULATOR_PUBKEY` are mandatory environment variables (fail-closed; keys are never auto-generated or written to `/data/keys.json`). Keeping the `/data` volume across redeploys preserves the oracle fixing history, desk wallet DB, quote book, and settler progress.

## Day to day

Inspect internal services on Railway via SSH:

```bash
railway ssh --service coinflip-mainnet -- wget -qO- http://127.0.0.1:8789/api/status
railway ssh --service coinflip-mainnet -- wget -qO- http://127.0.0.1:8788/status
railway ssh --service coinflip-mainnet -- wget -qO- http://127.0.0.1:8790/status
```

- **Desk float.** Desk `balance` is the float available to lock full payouts (`collateral`) for predictions; the desk refuses quotes it cannot cover with `float short`. The oracle is stateless and needs no Arkade wallet or on-chain funding.
- **DIA feed & canonical fixing.** The oracle streams DIA `OracleUpdate` prints for `BTC/USD` and retains 24 hours of history (`GET /api/prices?from=<unix>&to=<unix>`) and 48 hours of canonical fixings. Once a print strictly past `expiry + 60` arrives (or a 30-second fallback grace period elapses), `GET /api/fixing?expiry=<unix>` freezes the last DIA sample in `[expiry, expiry + 60]`, persists it, and returns both the signed DIA payload and the oracle's BIP340 Schnorr signature (`oracleSig`) over `SHA256("BTCUSD-FIX" || "fix" || num2bin(expiry, 8) || num2bin(cents, 8) || num2bin(time, 8))`.
- **Standalone settlement.** `PredictVaultV3.settle()` is a single-input Arkade transaction that verifies both signatures directly in script (`checkSigFromStack`) and pays 100% of `collateral` to the winner with zero read fee. Anyone can run a settler (`ORACLE_URL=... pnpm settle`) with no keys, no admin token, and no fee wallet.
- **Manual admin controls.** Inside the container, `POST /drain?enabled=1|0` on port `8788` (requires `Authorization: Bearer $DESK_ADMIN` or `$ORACLE_ADMIN`) pauses quoting cleanly while existing positions settle. See [docs/mainnet-runbook.md](docs/mainnet-runbook.md) for `scripts/backup-refund.ts` emergency L1 recovery.
- **Desk logs.** One line per UTC hour (`hour N quotes, N filled, N premium paid, N collateral locked`), plus immediate logs on fills. Set `DESK_LOG=debug` to log every quote.

## Predict

All-or-nothing calls on where Bitcoin closes at the end of a 5-minute or 15-minute window: higher (kind `2`) or lower (kind `3`). The page route is `#/predict`.

- **Contract (`PredictVaultV3`).** [contracts/predict_vault.ark](contracts/predict_vault.ark) verifies both the pinned DIA EIP-712 signature and `oraclePk`'s Schnorr signature over the single canonical fixing for `expiry`, preventing either side from cherry-picking among DIA prints in `[expiry, expiry + 60]` without needing a shared on-chain beacon coin. Above the line (higher) or below it (lower), the holder receives the full `collateral`; an exact tie pays the desk. Three-tier exit/void model:
  - **Tier 1 (Arkade):** `settle()`, `reboard()` (v2 intent proof via `executord` or page), `refund()` after `expiry + 24h` (`voidAfter = 86,400s`), and cooperative 2-of-2 `close()`.
  - **Tier 2 (Bitcoin L1 backup):** `refundBackup(backupSig)` via tweaked `backupPk` after `fallbackDelay` (`605,184s` / 7d on mainnet; `22,016s` / ~6.1h on Mutinynet). Because Bitcoin L1 does not execute the Arkade VM, after `fallbackDelay` the backup key custodian is trusted to sign only valid void refunds (`scripts/backup-refund.ts`).
  - **Tier 3 (Bitcoin L1 mutual):** 2-of-2 `unilateral(writerSig, holderSig)` after `finalExitDelay` (`691,200s` / 8d on mainnet; `108,032s` / ~30h on Mutinynet).
- **Fill & auto-refund.** `OptionIntent` side `1`. The bettor funds the intent with `stake`; the desk `finalize`s by taking `stake` and locking full `collateral` in `PredictVaultV3`. Unfilled stakes can be cancelled after `deadline` via `cancel()` (`OP_CHECKTIME`) or automatically via `executord` (`cancelCltv`).
- **Windows & lines.** Closes sit on the 5-minute grid, 1 to 60 minutes ahead (`PREDICT_MIN_LEFT_S = 30`, `PREDICT_LOCK_S = 30`, 60-second cutoff before close). `DESK_LINE_MODE=any` (default in `scripts/demo.mjs`) allows live-spot lines; `DESK_LINE_MODE=window` locks each 5-minute window to its opening DIA print.
- **Pricing & limits.** Multiplier is `floor(((1 - edge) / p) * 100) / 100` from Deribit ATM IV and the more adverse of DIA spot and Coinbase/Kraken/Binance median (freshly re-fetched and re-checked before fill so adverse moves during the 30s lock cannot snipe the desk). Default `DESK_EDGE = 0.05` (`1.90×` at even odds); multipliers outside `1.05×–10×` or payouts that do not beat `stake` are refused. Mainnet launch defaults: `STAKE_MIN = 10,000`, `STAKE_MAX = 100,000`, `DESK_STRIKE_CAP = 5,000,000`, `DESK_TOTAL_CAP = 20,000,000`, `Q_MAX = 50,000,000` sats (override via `DESK_STAKE_MAX`, `DESK_STRIKE_CAP`, `DESK_TOTAL_CAP`).
- **Delegations & guards.** Quotes fail closed unless `ORACLE_PUBKEY` matches the live oracle's pubkey and, on mainnet, unless an independent `BACKUP_EMULATOR_PUBKEY` (distinct from desk, oracle, and primary emulator) is pinned on both desk and page. The desk enforces per-pubkey/global RFQ rate limits and open-quote caps, registers `reboard` delegations on fill, and the page registers `cancel` + `reboard` delegations on placement with `EXECUTOR_URL`.
- **Page & phones.** The page proxies read-only DIA samples (`GET /oracle/prices`) and signed fixings (`GET /oracle/fixing`), emits strict CSP/security headers, blocks `.map` serving, supports responsive mobile drawers and standalone home-screen handoff (`/handoff/<id>`), and drops the Mutinynet warning banner on Bitcoin mainnet builds.

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

Mutinynet auto-generates keys into `/data/keys.json` on first start and walks through funding the desk in the UI.

### Bitcoin Mainnet (Railway)

Set `NETWORK=bitcoin`, `PORT=4173`, `PAGE_PORT=4173`, `RAILWAY_DOCKERFILE_PATH=coinflip.Dockerfile`, plus the four mandatory secrets (`ORACLE_KEY`, `DESK_KEY`, `ORACLE_ADMIN`, `BACKUP_EMULATOR_PUBKEY` — keeping `BACKUP_KEY` offline), attach a persistent `/data` volume, and deploy. Full provisioning, funding, and L1 recovery steps are in [docs/mainnet-runbook.md](docs/mainnet-runbook.md).

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

Typecheck, unit & integration tests, and browser bundle build:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Go Arkade VM contract tests (including TS↔Go Taproot parity and direct dual-signature `PredictVault.settle`):

```bash
(cd contracts/go && go test -v ./...)
```

Local Docker regtest end-to-end smoke test (Bitcoin regtest + `arkd` + `emulator`):

```bash
pnpm smoke:regtest
```
