export const PAIR = "arkade:BTC->arkade:BTC-OPTION";
/** Sealed RFQ. Kind 20000–29999 is ephemeral, and the payload is NIP-44 to one recipient. */
export const RFQ_KIND = 24859;
/** NIP-78 app data. One replaceable event per filled vault, tagged `arkade-option`. */
export const POSITION_KIND = 30078;
export const POSITION_TAG = "arkade-option";
// Mutinynet's unilateralExitDelay. Arkd refuses to cosign a vtxo whose shortest
// exit leaf is below this, and BIP68 seconds must be a multiple of 512.
export const EXIT = 2048n;
export const DUST_SATS = 330n;
/** Sats a beacon read adds. Above the 330-sat dust line. The vault pays this out of its collateral. */
export const BEACON_READ_FEE = 1_000n;
export const QUOTE_TTL_S = 30;
export const LOCK_S = 180;
export const ARK_URL = "https://mutinynet.arkade.sh";
export const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
export const Q_MIN = 10_000n;
export const Q_MAX = 1_000_000_000n;
export const PRICE_MAX = 1_000_000_000n;

export const DEFAULT_RELAYS = ["wss://nostr.arkade.sh"];

/**
 * Predict: an all-or-nothing call on where BTC closes, higher (kind 2) or lower
 * (kind 3) than a line. The bettor is the holder and pays the stake; the desk
 * is the writer and funds the payout into a PredictVault.
 */
export type PredictKind = 2 | 3;
export type OptionKind = 0 | 1;
export type Kind = OptionKind | PredictKind;
export function isPredict(kind: number): kind is PredictKind {
  return kind === 2 || kind === 3;
}
/** Windows close on this grid. A 15-minute window is one that closes on the quarter hour. */
export const PREDICT_GRID_S = 300;
/**
 * The stake has to arrive this soon after the quote. Three minutes, the options
 * lock, would let a bettor watch most of a 5-minute window before paying.
 */
export const PREDICT_LOCK_S = 60;
/** The window has to stay open at least this long after the lock deadline. */
export const PREDICT_MIN_LEFT_S = 60;
/** Furthest close the desk quotes. */
export const PREDICT_MAX_AHEAD_S = 3600;
export const STAKE_MIN = 10_000n;
export const STAKE_MAX = 1_000_000n;
/** The desk keeps this share of a fair price. 1.90× at even odds. */
export const PREDICT_EDGE = 0.05;
/** Multipliers outside this range are not quoted. */
export const MULTIPLIER_MIN = 1.05;
export const MULTIPLIER_MAX = 10;
