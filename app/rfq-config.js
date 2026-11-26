import { LIVE_BEACON_STATUS } from "./src/beacon-status.ts";

export const RELAYS = ["wss://nostr.arkade.sh"];

export const PINNED_BACKUP_PUBKEY = demoBackupPubkey();
export const PINNED_ORACLE_PUBKEY = demoOraclePubkey() ?? LIVE_BEACON_STATUS.args.adminPk.toLowerCase();

export const PINNED_DESKS = demoDesks() ?? [
  {
    name: "Mutinynet",
    pubkey: "eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9",
  },
];

function demoOraclePubkey() {
  const demo = typeof __COINFLIP_DEMO__ !== "undefined" ? __COINFLIP_DEMO__ : null;
  if (demo && typeof demo.oraclePubkey === "string" && /^[0-9a-f]{64}$/i.test(demo.oraclePubkey)) {
    return demo.oraclePubkey.toLowerCase();
  }
  const fromBeacon = demo?.beacon?.args?.adminPk ?? demo?.beacon?.pubkeys?.[0];
  return typeof fromBeacon === "string" && /^[0-9a-f]{64}$/i.test(fromBeacon)
    ? fromBeacon.toLowerCase()
    : null;
}

function demoBackupPubkey() {
  const demo = typeof __COINFLIP_DEMO__ !== "undefined" ? __COINFLIP_DEMO__ : null;
  return demo && typeof demo.backupPubkey === "string" && /^[0-9a-f]{64}$/i.test(demo.backupPubkey)
    ? demo.backupPubkey.toLowerCase()
    : null;
}

function demoDesks() {
  const demo = typeof __COINFLIP_DEMO__ !== "undefined" ? __COINFLIP_DEMO__ : null;
  return demo && Array.isArray(demo.desks) && demo.desks.length ? demo.desks : null;
}
