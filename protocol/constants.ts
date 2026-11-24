export const PAIR = "arkade:BTC->arkade:BTC-OPTION";
export const RFQ_KIND = 24859;
export const POSITION_KIND = 30078;
export const POSITION_TAG = "arkade-option";
export const OPTION_VAULT_PROGRAM_ID = "OptionVault";
export const PREDICT_VAULT_PROGRAM_ID = "PredictVault";
// Must match arkd's unilateralExitDelay and be a multiple of 512s for BIP68.
export const EXIT = 2048n;
export const DUST_SATS = 330n;
export const BEACON_READ_FEE = 1_000n;
export const QUOTE_TTL_S = 30;
export const LOCK_S = 180;
export const ARK_URL = "https://mutinynet.arkade.sh";
export const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
export const Q_MIN = 10_000n;
export const Q_MAX = 1_000_000_000n;
export const PRICE_MAX = 1_000_000_000n;

export const DEFAULT_RELAYS = ["wss://nostr.arkade.sh"];

export type PredictKind = 2 | 3;
export type OptionKind = 0 | 1;
export type Kind = OptionKind | PredictKind;

export function isPredict(kind: number): kind is PredictKind {
  return kind === 2 || kind === 3;
}

export function vaultProgramId(kind: number): string {
  return isPredict(kind) ? PREDICT_VAULT_PROGRAM_ID : OPTION_VAULT_PROGRAM_ID;
}

export const PREDICT_GRID_S = 300;
// Shorter than options' 180s lock to limit free-look time inside a 5-minute window.
export const PREDICT_LOCK_S = 60;
export const PREDICT_MIN_LEFT_S = 60;
export const PREDICT_MAX_AHEAD_S = 3600;
export const STAKE_MIN = 10_000n;
export const STAKE_MAX = 1_000_000n;
export const PREDICT_EDGE = 0.05;
export const MULTIPLIER_MIN = 1.05;
export const MULTIPLIER_MAX = 10;
export const PREDICT_VOID_AFTER = 86_400n;
// BIP68 512s units: ~6.1h primary response window before Tier 2 backup, +~1h buffer to Tier 3 2-of-2.
export const PREDICT_FALLBACK_DELAY = 22_016n;
export const PREDICT_FINAL_EXIT_DELAY = 25_600n;
