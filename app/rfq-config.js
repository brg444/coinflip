/** The page asks for quotes on this relay only. */
export const RELAYS = ["wss://nostr.arkade.sh"];

/**
 * Nostr pubkeys of desks that quote arkade:BTC->arkade:BTC-OPTION.
 * The pubkey is the desk's x-only key. Empty prices the page from the
 * Deribit mark directly. The page only submits intents on the relay.
 */
export const PINNED_DESKS = demoDesks() ?? [
  {
    name: "Mutinynet",
    pubkey: "eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9",
  },
];

/** `pnpm demo` builds the page against its own desk. Every other build pins the one above. */
function demoDesks() {
  // eslint-disable-next-line no-undef
  const demo = typeof __COINFLIP_DEMO__ !== "undefined" ? __COINFLIP_DEMO__ : null;
  return demo && Array.isArray(demo.desks) && demo.desks.length ? demo.desks : null;
}
