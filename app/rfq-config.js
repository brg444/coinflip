export const RELAYS = ["wss://nostr.arkade.sh"];

export const PINNED_BACKUP_PUBKEY = demoBackupPubkey();

export const PINNED_DESKS = demoDesks() ?? [
  {
    name: "Mutinynet",
    pubkey: "eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9",
  },
];

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
