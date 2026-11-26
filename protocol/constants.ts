export const PAIR = "arkade:BTC->arkade:BTC-OPTION";
export const RFQ_KIND = 24859;
export const POSITION_KIND = 30078;
export const POSITION_TAG = "arkade-option";
export const PREDICT_VAULT_PROGRAM_ID = "PredictVaultV3";
// Must match arkd's unilateralExitDelay and be a multiple of 512s for BIP68.
export const EXIT = 2048n;
export const DUST_SATS = 330n;
export const QUOTE_TTL_S = 30;
export const ARK_URL = "https://mutinynet.arkade.sh";
export const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
export const EXECUTOR_URL = "https://executor.mutinynet.arkade.sh";
export const Q_MAX = 1_000_000_000n;
export const PRICE_MAX = 1_000_000_000n;

export const DEFAULT_RELAYS = ["wss://nostr.arkade.sh"];

export type PredictKind = 2 | 3;
export type Kind = PredictKind;

export const PREDICT_GRID_S = 300;
// Short lock window to limit free-look time inside a 5-minute prediction window.
export const PREDICT_LOCK_S = 30;
export const PREDICT_MIN_LEFT_S = 30;
export const PREDICT_MAX_AHEAD_S = 3600;
export const STAKE_MIN = 10_000n;
export const STAKE_MAX = 1_000_000n;
export const PREDICT_EDGE = 0.05;
export const MULTIPLIER_MIN = 1.05;
export const MULTIPLIER_MAX = 10;
export const PREDICT_VOID_AFTER = 86_400n;
// BIP68 512s units: ~6.1h primary response before Tier 2 backup; ~30h (> voidAfter) before Tier 3 2-of-2.
export const PREDICT_FALLBACK_DELAY = 22_016n;
export const PREDICT_FINAL_EXIT_DELAY = 108_032n;
