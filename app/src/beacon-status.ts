// Bundled copy of Mutinynet oracle /api/status; pnpm demo injects its own beacon.
declare const __COINFLIP_DEMO__: { beacon?: typeof PINNED_BEACON_STATUS } | null | undefined;

const demoBeacon = typeof __COINFLIP_DEMO__ !== "undefined" && __COINFLIP_DEMO__?.beacon ? __COINFLIP_DEMO__.beacon : null;

const PINNED_BEACON_STATUS = {
  pubkeys: ["e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe"],
  assetId: "58db69a7a8a64cd1b16fa7ec4dba2c49a62815d88d0f7a660e216c0206e975c20000",
  issueTxid: "58db69a7a8a64cd1b16fa7ec4dba2c49a62815d88d0f7a660e216c0206e975c2",
  address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf849c8k9fmuplslxvex94jqct8d58l229c0jh2seve4ky0n3xy0rjwr978pd",
  args: {
    ctrlTxid: "c275e906026c210e667a0f8dd81528a6492cba4deca76fb1d14ca6a8a769db58",
    domain: "4254435553442d464958",
    expiryLag: 60,
    readFee: 1000,
    adminPk: "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
    exit: 2048,
  },
  fixings: [
    {
      expiry: 1794740208,
      price: "6547566",
      time: 1794740227,
      raw: "65475660863768696455168",
      nonce: "1793790301274552364",
      intentExpiry: 1794743827,
      sig: "0e033152d22ecb653f3de06a641fe2f98d28c0eb31483863fe0723ca4e1f6b0f70dd89f34702e7486da6ce3058f05c723aa21ba4cc99768f82d72afee4096974",
      txid: "dea11283245be3ac269e1c9acb36036da2d40d5b66becd3533a922e1312c7f92",
    },
  ],
};

export const LIVE_BEACON_STATUS = demoBeacon ?? PINNED_BEACON_STATUS;
