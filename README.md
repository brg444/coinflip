# COINFLIP

Bet whether bitcoin closes higher or lower than a line in five minutes. Each bet is an all-or-nothing contract on Arkade: the stake and the desk's payout sit in a vault that only the oracle's fixing can settle. Closed beta on Mutinynet. Domain: coinflip.casino.

Forked from [ArkLabsHQ/arkade-options](https://github.com/ArkLabsHQ/arkade-options), which keeps its cash-settled covered calls and limited puts. The bet is in [Predict](#predict); `pnpm demo` runs it all on one machine ([Demo](#demo)).

Day-to-day work is funding the desk. The oracle signs BTCUSD itself and keeps the history. The settler publishes a fixing after expiry and settles the vault. A new beacon is a new identity. Deploy and bootstrap steps are in [docs/runbook.md](docs/runbook.md).

## Live

Traefik serves these domains with its default certificate. `curl` needs `-k`.

| | |
| --- | --- |
| Page | <https://arkade.trade/> |
| Fund flow | <https://arkade.trade/viz/> |
| Oracle | <https://app-input-bluetooth-program-he5gtr-bb8d3b-138-199-218-130.traefik.me/> |
| Desk | <https://app-quantify-cross-platform-bus-bwux4e-31e3a4-138-199-218-130.traefik.me/> |
| Settler | <https://app-back-up-redundant-system-a7rla7-995a33-138-199-218-130.traefik.me/> |
| Oracle volume | `oracle-week-data` mounted at `/data` (`oracle.json`, `arkade.sqlite`) |
| Desk volume | `desk-week-data` mounted at `/data` (`book.json`, `arkade.sqlite`) |
| Settler volume | `settler-week-data` mounted at `/data` (`progress.json`) |

Beacon (Mutinynet). `BEACON_TXID` is the oracle's `issueTxid`. `ctrlTxid` is that same txid with the bytes reversed; the script compares the reversed form.

| | |
| --- | --- |
| `issueTxid` / `BEACON_TXID` | `c919606acba781572d5f72e53ffc6d125c98fbbd36df69eaf6f9613bae25499d` |
| `assetId` | `c919606acba781572d5f72e53ffc6d125c98fbbd36df69eaf6f9613bae25499d0000` |
| `deployTxid` | `8faf199b199ddd3f3b88c1b290805a1dd78254864f1dd9963d5278d7f45836fa` |
| `ctrlTxid` | `9d4925ae3b61f9f6ea69df36bdfb985c126dfc3fe5725f2d5781a7cb6a6019c9` |
| Beacon address | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf8449krp83vcrs7yq9vlyn3k7kr3739l3y5dsqqg5xl3tqwtwse5u4kf3yhw` |
| Oracle wallet | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85q9pwqnt6gkk63gqu8kq6hn67g6rxft96nc3tschxa2mrxn8a63d3ltm5j` |
| Admin pubkey | `e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe` |
| Desk nostr pubkey | `eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9` |
| Desk deposit address | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85yqmhrwnt5zuhcr935nk7w7avtt3nf3kvvucn63tmrsx6q7h9x4txm6sw2` |

`ORACLE_KEY`, `ORACLE_ADMIN`, and `DESK_KEY` live in Dokploy, not on the volume. A redeploy keeps the beacon, the wallet, and the quote book. Replacing a volume, or rotating `ORACLE_KEY`, starts a different beacon. The page settles the beacon in this table. `app/src/beacon-status.ts` is a copy of the oracle `GET /api/status`, because the browser does not trust the Traefik certificate. Quotes use the desk nostr pubkey in `app/rfq-config.js`. The coin at `76ba2970…da89` remains on the previous Oracle and Desk services.

## Day to day

Oracle status is `GET /api/status`. Desk status is `GET /` (same body as `GET /status`). That body lists live quotes only, one page of 50. Finished quotes are not kept. `GET /quotes?status=live&limit=50&offset=0` is the next page (`status` is `live`, `open`, `filled`, or `all`).

```bash
curl -k https://app-input-bluetooth-program-he5gtr-bb8d3b-138-199-218-130.traefik.me/api/status
curl -k https://app-quantify-cross-platform-bus-bwux4e-31e3a4-138-199-218-130.traefik.me/
```

Oracle `balance` is spendable sats on the admin wallet. The beacon coin itself is separate. Desk `balance` is the float. The desk `BEACON_TXID` is the `issueTxid` in the table above.

Fund the desk at its deposit address. Send enough for premiums. The seller's collateral does not come from this float. `balance` stays `0` until the coins arrive. The desk refuses a quote it cannot pay and logs `float short`.

The aggregator holds one to five oracle keys (`ORACLE_SIGNERS`, or just `ORACLE_KEY` when testing with one). Every minute it signs a BTCUSD sample with each of them and keeps those signatures for 24 hours. `GET /api/prices?from=<unix>&to=<unix>` returns that history, signatures included, so anyone can use them. A fixing is the sample inside `[expiry, expiry + 60]`, or, if that minute was missed, the latest sample at or before `expiry + 60`. The aggregator writes that fixing in one beacon transaction after `expiry + 60`. Reading the beacon costs 1,000 sats, above the dust line, paid by the vault:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":1790463992}' \
  https://app-input-bluetooth-program-he5gtr-bb8d3b-138-199-218-130.traefik.me/api/publish
```

The beacon keeps the eight newest fixings. Settle a vault before eight later expiries are published, or publish that expiry again.

The oracle watches the same filled-vault events. On its sample minute, once `expiry + 60` seconds have passed and a sample exists, it publishes that expiry. It does not settle. The settler still spends the vault. Once `expiry + 60` seconds have passed, about once a minute, it asks the oracle to publish that expiry and then spends the vault and the beacon together. A failed publish does not stop the other vaults. `already a fixing` is settled. The 1,000-sat read fee comes out of the vault collateral. The settler does not keep a fee wallet and does not call the desk. Set `ORACLE_ADMIN` on the settler so it can publish. Anyone else can run the same process. The first valid spend wins.

A vault txid alone is not enough. The event (or a `POSITIONS` file of the same JSON) also has to carry the contract parameters: kind, strike, expiry, beacon, and the writer and holder keys. The price comes from the beacon coin. Deploy steps, the event fields, and the file are in [docs/runbook.md](docs/runbook.md).

```bash
export ORACLE_URL=https://<oracle>
export ORACLE_ADMIN=<the oracle admin bearer>
pnpm settle
```

Desk logs: one line per UTC hour, `hour N quotes, N filled, N premium paid, N collateral locked` (sats). A fill still logs immediately with its txid. `DESK_LOG=debug` prints each quote.

## Beacon args

`args` on `/api/status` is the constructor of the live beacon script. These values are fixed at deploy. They are not a fee schedule you can edit.

```json
{
  "ctrlTxid": "<issue txid reversed>",
  "domain": "4254435553442d464958",
  "keyLag": 60,
  "readFee": 1000,
  "adminPk": "<ORACLE_KEY x-only pubkey>",
  "exit": 2048
}
```

| Field | Meaning |
| --- | --- |
| `ctrlTxid` | Identity of the beacon asset, as the script compares it: the display `issueTxid` reversed. The vault checks that input 1 holds one unit of this asset. |
| `domain` | Hex of the ASCII string `BTCUSD-FIX`. It is mixed into the migrate signature. |
| `keyLag` | Seconds after the expiry before `attest` is allowed. `60` means a fixing waits until the close minute has ended. |
| `readFee` | Sats added to the beacon on every `read`. The service uses `1000`, above the 330-sat dust line. The vault pays it out of its collateral. |
| `adminPk` | X-only pubkey of `ORACLE_KEY`. It signs `sha256(ctrlTxid \|\| BTCUSD \|\| price \|\| time)`. |
| `exit` | Seconds the admin must wait before a unilateral exit of the beacon coin to Bitcoin. `2048` is Mutinynet's `unilateralExitDelay`. |

The status object omits `ctrlGidx` (it is `0`, the `0000` suffix on `assetId`).

## Predict

All-or-nothing calls on where BTC closes at the end of a short window: higher (kind 2) or lower (kind 3) than a line. The page is `#/predict`.

- **Contract.** `contracts/predict_vault.ark` is OptionVault with the payoff swapped and nothing else: the same beacon read, read fee, dust folding and spend paths. Above the line (higher) or below it (lower), the holder gets the whole collateral less the read fee; a close on the line pays the writer. OptionVault is unchanged, so open option vaults keep their addresses.
- **Fill.** OptionIntent side 1, unchanged. The bettor is the holder and funds the intent with the stake. The desk is the writer: finalize pays the stake to the desk at output 0 and funds the vault with the payout from the desk float at output 1. A stake the desk does not fill is cancelled back to the bettor after the deadline.
- **Wire.** A predict `rfq_request` names `holder_pubkey` and `holder_pk_script` (the bettor's address) and `amount` is the stake. The quote names the desk as `writer_pubkey` and `writer_pk_script`, and `to_amount` is the payout. A filled position carries `holder_pk_script` so a settler can rebuild the vault.
- **Windows.** Closes are on the 5-minute grid, at least 2 minutes and at most an hour away. The stake has to arrive within 60 seconds of the quote (`PREDICT_LOCK_S`): the 3-minute options lock would let a bettor watch most of a window before paying.
- **Price.** The multiplier is `(1 - edge) / p`, where `p` is the lognormal chance of finishing on the bettor's side at the at-the-money Deribit IV of the nearest expiry at least six hours out. `DESK_EDGE` sets the edge (default 0.05, so 1.90× at even odds). `DESK_VOL` overrides the vol for options and predictions alike. Multipliers outside 1.05× to 10× are refused, as is a payout that does not beat the stake after the read fee.
- **Float.** A prediction ties up the whole payout, not a premium, so open predictions count their payout against the float.

`pnpm smoke:regtest` runs a prediction after the option: a fill from the desk float, a refund of an unfilled stake, a fixing above the line and the payout to the bettor.

## Demo

`pnpm demo` runs the whole system on one machine against Mutinynet, so the page can be tried end to end without the hosted services: an oracle with its own beacon, a desk, a settler, and the page built against that desk and beacon. It needs Node 22.12 or later and `pnpm install`.

The page comes up first. Until the demo is funded, a pill in the header reads "Fund demo 1/2" and opens the two steps: send 10,000 Mutinynet sats to the oracle wallet, which issues and deploys the beacon, then about 1,000,000 sats to the desk, since the desk funds whole payouts. Each step ticks off when the sats arrive and the pill goes away once the desk is quoting.

The page is served on <http://127.0.0.1:4173/>. With [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed it also opens a quick tunnel and prints a public `trycloudflare.com` URL, which needs no Cloudflare account and changes on every start. `pnpm demo -- --pages` also publishes the page to Cloudflare Pages as the `coinflip` project after `npx wrangler login`. Either URL works only while the demo is running, because the desk, oracle and settler run on this machine. `--no-tunnel` serves locally only.

Keys, data and logs live in `~/.coinflip-demo`; delete it to start over with a new beacon and desk. The demo listens on the same nostr relay as the hosted services, so its oracle and settler also see their positions and skip any vault bound to another beacon.

## Page

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4173/>. Quotes use `wss://nostr.arkade.sh`. The pinned desk is `app/rfq-config.js`. GitHub Pages publishes `dist/` on every push to `master`.

```bash
docker build -f site.Dockerfile -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

## Check

```bash
pnpm test
```

Local arkade regtest (Docker, bitcoin regtest + arkd + emulator):

```bash
pnpm smoke:regtest
```

That runs the option the contracts settle. The oracle service issues and deploys the beacon, one intent is finalized, the other is cancelled, the oracle publishes the strike, and the vault settles. It fails unless the beacon is deployed and the strike payout lands. The coins in that run are drawn at [viz/index.html](viz/index.html), also linked from the page as Fund flow. Details are in [docs/runbook.md](docs/runbook.md).
