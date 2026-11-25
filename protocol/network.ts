import { networks, type Network } from "@arkade-os/sdk";

import {
  ARK_URL,
  EMULATOR_URL,
  EXECUTOR_URL,
  EXIT,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_VOID_AFTER,
  Q_MAX,
  STAKE_MAX,
  STAKE_MIN,
} from "./constants.ts";

export type NetworkId = "bitcoin" | "mutinynet" | "regtest" | "testnet" | "signet";

export type NetworkProfile = {
  id: NetworkId;
  label: string;
  isMainnet: boolean;
  network: Network;
  hrp: string;
  arkUrl: string;
  emulatorUrl: string;
  executorUrl: string;
  walletUrl: string;
  explorerTxUrl: string;
  exit: bigint;
  voidAfter: bigint;
  fallbackDelay: bigint;
  finalExitDelay: bigint;
  qMax: bigint;
  stakeMin: bigint;
  stakeMax: bigint;
  deskStrikeCap: bigint;
  deskTotalCap: bigint;
};

export const MAINNET_EXIT = 605_184n;
export const MAINNET_FALLBACK_DELAY = 605_184n;
export const MAINNET_FINAL_EXIT_DELAY = 691_200n;
export const MAINNET_Q_MAX = 50_000_000n;
export const MAINNET_STAKE_MAX = 100_000n;
export const MAINNET_DESK_STRIKE_CAP = 5_000_000n;
export const MAINNET_DESK_TOTAL_CAP = 20_000_000n;

const BY_NAME: Record<string, Network> = {
  bitcoin: networks.bitcoin,
  mainnet: networks.bitcoin,
  testnet: networks.testnet,
  signet: networks.signet,
  mutinynet: networks.mutinynet,
  regtest: networks.regtest,
};

const PROFILES: Record<NetworkId, NetworkProfile> = {
  bitcoin: {
    id: "bitcoin",
    label: "Bitcoin",
    isMainnet: true,
    network: networks.bitcoin,
    hrp: networks.bitcoin.hrp,
    arkUrl: "https://arkade.computer",
    emulatorUrl: "https://emulator.arkade.computer",
    executorUrl: "https://executor.arkade.sh",
    walletUrl: "https://arkade.money",
    explorerTxUrl: "https://explorer.arkade.sh/tx/",
    exit: MAINNET_EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MAINNET_FALLBACK_DELAY,
    finalExitDelay: MAINNET_FINAL_EXIT_DELAY,
    qMax: MAINNET_Q_MAX,
    stakeMin: STAKE_MIN,
    stakeMax: MAINNET_STAKE_MAX,
    deskStrikeCap: MAINNET_DESK_STRIKE_CAP,
    deskTotalCap: MAINNET_DESK_TOTAL_CAP,
  },
  mutinynet: {
    id: "mutinynet",
    label: "Mutinynet",
    isMainnet: false,
    network: networks.mutinynet,
    hrp: networks.mutinynet.hrp,
    arkUrl: ARK_URL,
    emulatorUrl: EMULATOR_URL,
    executorUrl: EXECUTOR_URL,
    walletUrl: "https://mutinynet.arkade.money",
    explorerTxUrl: "https://explorer.mutinynet.arkade.sh/tx/",
    exit: EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    finalExitDelay: PREDICT_FINAL_EXIT_DELAY,
    qMax: Q_MAX,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX,
    deskStrikeCap: 100_000_000n,
    deskTotalCap: 500_000_000n,
  },
  regtest: {
    id: "regtest",
    label: "Regtest",
    isMainnet: false,
    network: networks.regtest,
    hrp: networks.regtest.hrp,
    arkUrl: "http://127.0.0.1:7070",
    emulatorUrl: "http://127.0.0.1:7073",
    executorUrl: "",
    walletUrl: "https://mutinynet.arkade.money",
    explorerTxUrl: "https://explorer.mutinynet.arkade.sh/tx/",
    exit: EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    finalExitDelay: PREDICT_FINAL_EXIT_DELAY,
    qMax: Q_MAX,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX,
    deskStrikeCap: 100_000_000n,
    deskTotalCap: 500_000_000n,
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    isMainnet: false,
    network: networks.testnet,
    hrp: networks.testnet.hrp,
    arkUrl: ARK_URL,
    emulatorUrl: EMULATOR_URL,
    executorUrl: EXECUTOR_URL,
    walletUrl: "https://mutinynet.arkade.money",
    explorerTxUrl: "https://explorer.mutinynet.arkade.sh/tx/",
    exit: EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    finalExitDelay: PREDICT_FINAL_EXIT_DELAY,
    qMax: Q_MAX,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX,
    deskStrikeCap: 100_000_000n,
    deskTotalCap: 500_000_000n,
  },
  signet: {
    id: "signet",
    label: "Signet",
    isMainnet: false,
    network: networks.signet,
    hrp: networks.signet.hrp,
    arkUrl: ARK_URL,
    emulatorUrl: EMULATOR_URL,
    executorUrl: EXECUTOR_URL,
    walletUrl: "https://mutinynet.arkade.money",
    explorerTxUrl: "https://explorer.mutinynet.arkade.sh/tx/",
    exit: EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    finalExitDelay: PREDICT_FINAL_EXIT_DELAY,
    qMax: Q_MAX,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX,
    deskStrikeCap: 100_000_000n,
    deskTotalCap: 500_000_000n,
  },
};

export function normalizeNetworkName(name?: string | null): NetworkId {
  const clean = name?.trim().toLowerCase() || "mutinynet";
  if (clean === "mainnet" || clean === "bitcoin") return "bitcoin";
  if (clean === "mutinynet" || clean === "regtest" || clean === "testnet" || clean === "signet") return clean;
  throw new Error(`unsupported ark network ${name}`);
}

export function isMainnetName(name?: string | null): boolean {
  const clean = name?.trim().toLowerCase();
  return clean === "bitcoin" || clean === "mainnet";
}

export function networkProfile(name?: string | null): NetworkProfile {
  return PROFILES[normalizeNetworkName(name)];
}

export function assertNetworkMatch(expected: string | undefined, actual: string): NetworkProfile {
  const actualProfile = networkProfile(actual);
  if (expected?.trim()) {
    const wanted = networkProfile(expected);
    if (wanted.id !== actualProfile.id) {
      throw new Error(`NETWORK=${wanted.id} does not match arkd network ${actualProfile.id}`);
    }
  }
  return actualProfile;
}

/** Network advertised by arkd `/v1/info`. The emulator co-signer is pinned per network. */
export function networkByName(name: string): Network {
  const network = BY_NAME[name.trim().toLowerCase()];
  if (!network) throw new Error(`unsupported ark network ${name}`);
  return network;
}
