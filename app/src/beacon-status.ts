/**
 * Public constructor the page settles against. The oracle certificate is not
 * trusted by the browser, so this is a copy of GET /api/status on the
 * Mutinynet oracle. Replace it when that beacon changes.
 */
declare const __COINFLIP_DEMO__: { beacon?: typeof PINNED_BEACON_STATUS } | null | undefined;

/** `pnpm demo` swaps in its own oracle's status. Every other build uses the pinned one. */
const demoBeacon = typeof __COINFLIP_DEMO__ !== "undefined" && __COINFLIP_DEMO__?.beacon ? __COINFLIP_DEMO__.beacon : null;

const PINNED_BEACON_STATUS = {
  pubkeys: ["e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe"],
  assetId: "c919606acba781572d5f72e53ffc6d125c98fbbd36df69eaf6f9613bae25499d0000",
  issueTxid: "c919606acba781572d5f72e53ffc6d125c98fbbd36df69eaf6f9613bae25499d",
  address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf8449krp83vcrs7yq9vlyn3k7kr3739l3y5dsqqg5xl3tqwtwse5u4kf3yhw",
  args: {
    ctrlTxid: "9d4925ae3b61f9f6ea69df36bdfb985c126dfc3fe5725f2d5781a7cb6a6019c9",
    signersN: 1,
    threshold: 1,
    domain: "4254435553442d464958",
    keyLag: 60,
    readFee: 1000,
    adminPk: "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
    exit: 2048,
  },
};

export const LIVE_BEACON_STATUS = demoBeacon ?? PINNED_BEACON_STATUS;
