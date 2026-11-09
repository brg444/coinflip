# Mutinynet user test (Dokploy)

Use this after `pnpm smoke:regtest` has passed. This is a fresh Mutinynet deploy: one oracle, one beacon, one desk, and one settler. In the Dokploy project `Arkade-Options`, create three new services: **Oracle**, **Desk**, and **Settler**. Do not edit the old Oracle and Desk in place, and do not mount their volumes. The identity asset recorded in the README (`76ba2970…da89`) was deployed with the old script. This build will not spend it.

The public HTTPS origin is the globe Dokploy puts on that new service. This repo does not store those origins. `curl` against a Traefik default certificate needs `-k`, as noted in the [README](../README.md).

The three images clone GitHub `master` ([oracle/Dockerfile](../oracle/Dockerfile), [Dockerfile](../Dockerfile), [settle/Dockerfile](../settle/Dockerfile)). Build them after this change is on `master`, or the oracle dashboard will not have the settlement screen.

Never put `ORACLE_KEY`, `ORACLE_ADMIN`, or `DESK_KEY` in the repo. Generate them locally and paste them into the new services.

```bash
openssl rand -hex 32   # ORACLE_KEY and, separately, DESK_KEY
openssl rand -hex 16   # ORACLE_ADMIN
```

## What not to change

- Do not write a second settler. The process is [settle/main.ts](../settle/main.ts), image [settle/Dockerfile](../settle/Dockerfile).
- Do not change `EXIT`, `DUST_SATS`, or `BEACON_READ_FEE` in [protocol/constants.ts](../protocol/constants.ts). There is no env var for them. Dust stays `330` sats. The read fee stays `1000` sats so the number is easy to account. Do not zero either one. The zeros in [.env.regtest](../.env.regtest) are arkade-regtest intent fees for the smoke stack only. They are not service settings, and this deploy does not copy them onto Mutinynet.
- Mutinynet only. Do not point `ARK_URL` at the regtest ports from the smoke test, or at any other network.
- Leave `SAMPLE_MS` unset. The oracle stores a Deribit BTC index sample about once a minute ([oracle/price.ts](../oracle/price.ts)), which is what publish needs inside an expiry window. `0` uses that same minute.
- Do not change the wallet target. The page already uses `https://mutinynet.arkade.money` ([app/src/fund.ts](../app/src/fund.ts), [app/index.html](../app/index.html)).

## Exit delay

Contracts use `EXIT = 2048` seconds ([protocol/constants.ts](../protocol/constants.ts)). BIP68 seconds must be a multiple of 512, and arkd refuses a vtxo whose shortest exit leaf is below `unilateralExitDelay`. The desk calls `assertServerExit` on boot and exits if the server delay is not `2048` ([protocol/contracts.ts](../protocol/contracts.ts), [desk/main.ts](../desk/main.ts)).

The repo does not record a live Mutinynet `/v1/info`. Before issue:

```bash
curl -fsS https://mutinynet.arkade.sh/v1/info
```

`network` must be `mutinynet` (the name [protocol/network.ts](../protocol/network.ts) accepts) and `unilateralExitDelay` must be `2048`. If it is not, stop. Do not edit `EXIT` to match the server. The smoke stack forces the same delay with `ARKD_UNILATERAL_EXIT_DELAY=2048` in [.env.regtest](../.env.regtest). That file does not configure the public arkd.

## Environment

Set these on the **new** service. Defaults below are what the process uses when the variable is unset. Each service gets a new volume mounted at `/data`. Do not reuse the volumes already mounted on the old Oracle and Desk services.

### Oracle service

From [oracle/main.ts](../oracle/main.ts) and [oracle/Dockerfile](../oracle/Dockerfile).

| Env | Fresh deploy |
| --- | --- |
| `ORACLE_KEY` | New 32-byte hex. Wallet, issuer, and the only price signer. |
| `ORACLE_ADMIN` | New bearer for `/api/issue`, `/api/deploy`, `/api/recover`, `/api/samples`, and `/api/publish`. Unset disables those routes. |
| `ARK_URL` | `https://mutinynet.arkade.sh` (the code default). |
| `EMULATOR_URL` | `https://emulator.mutinynet.arkade.sh` (the code default). |
| `SAMPLE_MS` | Leave unset. Stores a Deribit index sample about once a minute. `0` uses that same minute. |
| `DATA_DIR` | Leave the image value `/data`. |
| `PORT` | Leave `8789`. |
| `ORACLE_SIGNERS`, `ORACLE_THRESHOLD` | Leave unset. One `ORACLE_KEY` is the signer, threshold 1. |

Build type Dockerfile. **Docker File** `oracle/Dockerfile`. **Docker Context Path** `/oracle` or `/`. The image clones the repo, so either context works. Do not use the repository-root `Dockerfile` for this service: that image is the desk (port `8788`). Port `8789` behind the domain on this service. The dashboard is `GET /`.

### Desk service

The desk is public. It has no admin bearer. `GET /` and `GET /quotes` are open. It speaks Mutinynet only.

From [desk/main.ts](../desk/main.ts) and the root [Dockerfile](../Dockerfile).

| Env | Fresh deploy |
| --- | --- |
| `DESK_KEY` | New 32-byte hex. Nostr pubkey and the option holder key. |
| `BEACON_TXID` | The new oracle `issueTxid`, 64 hex characters. The process exits if this is missing or not 64 hex. Set it after deploy, then restart. |
| `BEACON_GIDX` | Leave unset (`0`) unless status shows the identity asset at another vout. |
| `ORACLE_URL` | Origin of the Oracle service. At startup the desk reads `args.expiryLag` once and refuses a quote unless it is `60`, the window `OptionVault` hardcodes. |
| `ARK_URL` | `https://mutinynet.arkade.sh`. |
| `EMULATOR_URL` | `https://emulator.mutinynet.arkade.sh`. |
| `RELAYS` | Leave unset. Default is `wss://nostr.arkade.sh`. |
| `DATA_DIR` | Leave `/data`. |
| `PORT` | Leave `8788`. |
| `DESK_STRIKE_CAP`, `DESK_TOTAL_CAP`, `DESK_VOL`, `DESK_LOG` | Leave unset. Defaults are 1 BTC per strike, 5 BTC total, Deribit vol for quotes, and an hourly log line. `DESK_VOL` overrides the quote vol. It does not set the settlement price. |

Build the repository-root `Dockerfile`. Port `8788`. Turn the public globe on.

`ARK_URL` and `EMULATOR_URL` select the host. The network name comes from arkd `GET /v1/info`. The same two variables are how Oracle, Desk, and Settler point at Mutinynet.

### Settler service

A vault should settle when its window opens after the published price, without a tester clicking. This service does that. It does not quote, fill, or call the desk.

From [settle/main.ts](../settle/main.ts) and [settle/Dockerfile](../settle/Dockerfile).

| Env | Fresh deploy |
| --- | --- |
| `ORACLE_URL` | Origin of the new Oracle service (the globe). The beacon script comes from `GET /api/status`. |
| `ORACLE_ADMIN` | The same bearer as the Oracle service, so a missing fixing can be published. |
| `ARK_URL` | `https://mutinynet.arkade.sh`. |
| `EMULATOR_URL` | `https://emulator.mutinynet.arkade.sh`. |
| `RELAYS` | Leave unset. Default is `wss://nostr.arkade.sh`. Filled vaults are kind `30078`. |
| `DATA_DIR` | Leave `/data`. Holds `progress.json` for this process only. |
| `PORT` | Leave `8790`. |
| `DESK_KEY` | Do not set it. |
| `POSITIONS` | Leave unset. The relay subscription is the path. |

**Docker File** `settle/Dockerfile`. **Docker Context Path** `/` or `/settle`. Port `8790`. New volume at `/data`.

The image starts `node --experimental-strip-types settle/main.ts`. On boot it connects to Mutinynet, subscribes to the relay, and ticks every 2 seconds. `GET /status` returns `commit`, `oracle`, `relay`, `watching`, and `settled`.

When a fill is published, the settler rebuilds the vault from that event. Once `expiry + 60` has passed, about once a minute, it `POST`s `/api/publish` for that expiry and then spends the vault. `no sample` or any other publish failure is logged and the pass continues with the next vault. `409 already a fixing` means that expiry is already on the beacon. The settler reads the slot and settles only when its price and time are the sample the oracle would have chosen for that expiry. If the settler logs that a fixing is not the oracle sample more than 24 hours after expiry, the sample history has been pruned and the writer's unilateral exit is the backstop; do not re-publish from an old print. One beacon coin settles one vault per pass. The 1,000-sat read fee comes out of the vault. The settler holds no key and no fee wallet. The oracle still samples about once a minute; it does not attest a new expiry on every clock minute.

## Beacon fees

Fixed in [protocol/constants.ts](../protocol/constants.ts) and copied into the beacon at deploy ([oracle/service.ts](../oracle/service.ts)). Not a Dokploy schedule.

| | Value | Where |
| --- | --- | --- |
| Dust on the beacon coin | `330` sats (`DUST_SATS`) | Deploy pays this onto the beacon ([protocol/beacon.ts](../protocol/beacon.ts)). A payoff leg at or below 330 sats is folded into the other output ([contracts/option_vault.ark](../contracts/option_vault.ark)). |
| Read fee | `1000` sats (`BEACON_READ_FEE`) | `args.readFee`. Kept at 1000 so settlement is easy to account. The vault pays it out of collateral. The regtest smoke test asserts both numbers. |

`GET /api/status` then shows `args.exit` `2048`, `args.readFee` `1000`, `args.expiryLag` `60`, and `args.domain` hex of `BTCUSD-FIX`.

## Fund, issue, deploy

`GET /api/status` on the new Oracle returns `wallet` and `balance`.

1. **Fund the oracle wallet.** Send Mutinynet sats to `wallet`. Issue requires `balance` of at least 330. An empty wallet returns `{"error":"fund wallet"}`. Deploy puts 330 sats on the beacon coin and, when the remainder is at least 330, returns the rest as change. The smoke test funds `Q_MIN` (10_000 sats) so that split can happen. **That 10_000 figure is the smoke-test funding amount, not a Mutinynet fee.**

2. **Issue** the identity asset (supply 1). `issueTxid` is the desk's `BEACON_TXID`. Dashboard: open the Oracle origin, paste the admin token, then Issue. Or:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/issue
```

`<oracle>` is the new Oracle service origin.

Issue uses submit-then-finalize. If the process dies after submit and before finalize, `balance` stays `0` and the wallet keeps a pending flag. Boot finalizes, or Recover pending on the dashboard, or:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/recover
```

An empty `finalized` and `pending` means the server no longer has that spend. Fund the wallet again.

3. **Deploy** the unit into the beacon script (dashboard Deploy, or the curl below).

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/deploy
```

Status then includes `assetId`, `issueTxid`, `deployTxid`, `address` (the beacon), and `args`. Set `BEACON_TXID` on the **new Desk service** to `issueTxid` and restart it. `GET /` on the desk must show that `beaconTxid`. `commit` must match the image you built. `args.ctrlTxid` is the issue txid reversed.

Start the Settler after the Oracle origin and `ORACLE_ADMIN` are set. It can boot before the beacon is deployed. It waits until a fill's expiry and a fixing exist.

## Fund the desk

`GET /` returns `address` and `balance`. Send Mutinynet sats to `address`. That float pays premiums. Collateral does not come from it. `balance` stays `0` until the coins are indexed. The desk refuses a quote it cannot pay and logs `float short`. A formula premium at or below 330 sats is quoted at 331 (`payablePremium` in [protocol/pricing.ts](../protocol/pricing.ts)). A 10-minute quote at or below the 1,000-sat read fee is quoted at 1,001 (`quotedPremium`). Friday quotes are not. Chain dust stays 330, and `premiumRefusal` in [protocol/messages.ts](../protocol/messages.ts) still rejects a premium that was not lifted. There is no other desk funding amount in the repo.

`GET /` also returns `pubkey`. Put that pubkey in the Mutinynet entry of [app/rfq-config.js](../app/rfq-config.js) and push `master` so the public page asks this desk. Leave the wallet URL alone. Automatic settlement does not read [app/src/beacon-status.ts](../app/src/beacon-status.ts). Leave that file unless you also want the page's own Settle button to spend this beacon.

## Price screen

The Oracle dashboard (`GET /`) previews a settlement and, separately, publishes the price. The process also stores a Deribit index sample about once a minute, on its own clock, without the admin route.

Type the kind (covered call or limited put), the price in USD cents, the strike in USD cents, and the collateral in sats. The line under the fields is the holder and writer amounts. The math is the vault's: `holderPayoff`, then the 1000-sat read fee, then the dust fold ([oracle/preview.ts](../oracle/preview.ts), [app/settle-math.js](../app/settle-math.js), [contracts/option_vault.ark](../contracts/option_vault.ark)). A filled vault locks the collateral, so the preview treats the locked coin as that collateral. Typing does not call `/api/samples` or `/api/publish`.

**Publish price** is a separate button. It needs the admin token and the position's expiry (unix seconds). It `POST`s `/api/samples` with the typed price, then `POST`s `/api/publish` with that expiry. Omit `time` and the server stamps the sample with its own clock. The sample-time field is a testing control and starts empty. When it is set, that unix second is the signed sample time. The beacon accepts it when it is positive and at or before `expiry + 60`, after the clock has reached that close. The script does not require the signed time to equal the wall clock, and it does not require `time >= expiry`. Publish still chooses a stored sample inside `[expiry, expiry + 60]`. Publish is allowed only after `expiry + 60`. If you click early, the sample is stored and the page reports the publish error. The settler calls publish again after the window and then settles. The beacon keeps eight fixings. Settle before eight newer expiries replace this one, or publish it again.

**Record price**, lower on the same page, only stores a sample. It sends the same optional sample time. It does not publish.

The same two calls, if you are not on the dashboard:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"price":"<integer cents>"}' https://<oracle>/api/samples

curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"price":"8277570","time":1791822006}' https://<oracle>/api/samples

curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":<unix expiry>}' https://<oracle>/api/publish
```

`"<integer cents>"` is the operator's price. `"10000000"` is $100,000.00, the shape this API already accepts. `GET /api/status` lists `fixings`. History is `GET /api/prices?from=<unix>&to=<unix>`.

## Testers

Testers use the public page ([README](../README.md) records <https://arkade.trade/>) and the public desk. Quotes go to `wss://nostr.arkade.sh`. **Open Arkade wallet** goes to `https://mutinynet.arkade.money`. The page talks to Mutinynet arkd at the same default `ARK_URL` and `EMULATOR_URL` ([app/src/fund.ts](../app/src/fund.ts)).

Testers fund themselves at <https://faucet.mutinynet.com>. The seller pays collateral from that wallet to the intent address the page shows. The desk pays the premium to the seller's Mutinynet address.

They do not have to click Settle. After you publish the price, the Settler spends the vault once `expiry + 60` has passed.

## Checks

Use one small option. Collateral must be at least `Q_MIN` (10_000 sats). Pick an expiry you can wait out. The fill deadline on the quote is not the expiry.

**Fill.** On the page, take a quote from this desk and send the collateral to the intent address before the deadline. The desk finalizes. The page shows the position filled. `GET /` on the desk includes that quote with a `fillTxid` while it is still live (a filled row is dropped once its expiry has passed). A fill also logs a txid. `GET /quotes?status=filled` is the filled page. The settler's `watching` count on `GET /status` includes the fill once the relay event arrives.

**Cancel.** Fund an intent and let the deadline pass without a fill. The page marks it expired and shows **Refund** when the coin is still unspent ([protocol/intent-state.ts](../protocol/intent-state.ts)). Refund spends `cancel` back to the seller. The button is not a fill. Cancel before the deadline is **Cancel trade**, which drops the row only while the intent is still open.

**Settle.** On the Oracle dashboard, preview the holder and writer amounts for that position's kind, strike, collateral, and the price you want. Then **Publish price** with the position expiry. After `expiry + 60`, `GET /api/status` shows the fixing and the Settler logs `settled` with a txid. `GET /status` on the Settler increments `settled`. No page click is required. The 1,000-sat read fee is the difference between the collateral and the holder plus writer amounts in the preview.

`scripts/e2e-mutinynet.ts` (`pnpm e2e`) is a scripted Mutinynet fill and cancel against `BEACON_TXID`. It is not the tester path, and its default keys are not the Dokploy `DESK_KEY`.

## Local regtest

The smoke test is the gate before this deploy, not a second production stack. From this repo, with Docker running:

```bash
pnpm smoke:regtest
```

[.env.regtest](../.env.regtest) sets `ARKD_UNILATERAL_EXIT_DELAY=2048` and zero intent fees, then starts bitcoin regtest, arkd, and the emulator. The test issues, deploys, fills one intent, cancels the other, publishes the strike, and settles. `ARK_URL` and `EMULATOR_URL` override the endpoints (defaults `http://127.0.0.1:7070` and `http://127.0.0.1:7073`). Leave those overrides off the Dokploy services.
