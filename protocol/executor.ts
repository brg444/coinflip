import { sha256 } from "@noble/hashes/sha2.js";

import type { arkade } from "@arkade-os/sdk";

import { bytesToHex, xOnly } from "./hex.ts";
import type { Bound } from "./contracts.ts";

export type Delegation = {
  templateId: string;
  variables: Record<string, string>;
};

export function scriptNumHex(n: bigint): string {
  const out: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) out.push(Number(v & 0xffn));
  if (out.length && (out[out.length - 1]! & 0x80)) out.push(0);
  return out.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function compressedEvenKeyHex(xOnlyKey: Uint8Array): string {
  return `02${bytesToHex(xOnly(xOnlyKey))}`;
}

// executord rejects composite ScriptPubKey constructor inputs; flatten them to .program (bytes32) + .version (int).
export function executorArtifact(artifact: arkade.ContractArtifact): Record<string, unknown> {
  const raw = artifact as unknown as { constructorInputs?: { name: string; type: string }[] };
  return {
    ...raw,
    constructorInputs: (raw.constructorInputs ?? []).flatMap((input) => (
      input.type === "ScriptPubKey"
        ? [{ name: `${input.name}.program`, type: "bytes32" }, { name: `${input.name}.version`, type: "int" }]
        : [input]
    )),
  };
}

export function cancelIntentTemplate(artifactId: string) {
  return {
    format: "template/v1",
    type: "virtual",
    variables: {
      user_pk: "pubkey",
      user_program: "bytes32",
      solver_program: "bytes32",
      option_program: "bytes32",
      side: "int",
      collateral: "int",
      premium: "int",
      deadline: "int",
      exit: "int",
    },
    inputs: [
      {
        name: "intent",
        contract: {
          definition: { artifact: artifactId },
          arguments: {
            userPk: "<user_pk>",
            "userScript.program": "<user_program>",
            "userScript.version": "01",
            "solverScript.program": "<solver_program>",
            "solverScript.version": "01",
            "optionScript.program": "<option_program>",
            "optionScript.version": "01",
            side: "<side>",
            collateral: "<collateral>",
            premium: "<premium>",
            deadline: "<deadline>",
            exit: "<exit>",
          },
        },
        spend: { function: "cancelAuto", leaf: "cancelCltv" },
      },
    ],
    outputs: [
      {
        name: "refund",
        index: 0,
        value: { from: "intent" },
        locking: "5120<user_program>",
      },
    ],
    packets: { output_index: 1 },
  };
}

export function reboardVaultTemplate(artifactId: string, renewalWindowSeconds = 86_400n) {
  return {
    format: "template/v1",
    type: "proof",
    variables: {
      kind: "int",
      writer_pk: "pubkey",
      holder_pk: "pubkey",
      writer_program: "bytes32",
      holder_program: "bytes32",
      strike: "int",
      collateral: "int",
      stake: "int",
      expiry: "int",
      oracle_pk: "pubkey",
      backup_pk: "pubkey",
      void_after: "int",
      fallback_delay: "int",
      final_exit_delay: "int",
    },
    inputs: [
      {
        name: "vault",
        contract: {
          definition: { artifact: artifactId },
          arguments: {
            kind: "<kind>",
            writerPk: "<writer_pk>",
            holderPk: "<holder_pk>",
            "writerScript.program": "<writer_program>",
            "writerScript.version": "01",
            "holderScript.program": "<holder_program>",
            "holderScript.version": "01",
            strike: "<strike>",
            collateral: "<collateral>",
            stake: "<stake>",
            expiry: "<expiry>",
            oraclePk: "<oracle_pk>",
            backupPk: "<backup_pk>",
            voidAfter: "<void_after>",
            fallbackDelay: "<fallback_delay>",
            finalExitDelay: "<final_exit_delay>",
          },
        },
        spend: { function: "reboard", leaf: "reboard" },
      },
    ],
    outputs: [
      {
        name: "renewed",
        value: { from: "vault" },
        locking: { from: "vault" },
      },
    ],
    packets: { unmatched: "drop" },
    delegation: {
      schedule: {
        vault: { before_expiry_seconds: Number(renewalWindowSeconds) },
      },
    },
  };
}

export function cancelIntentDelegation(templateId: string, bound: Bound): Delegation {
  return {
    templateId,
    variables: {
      user_pk: compressedEvenKeyHex(bound.intent.userPk as Uint8Array),
      user_program: bytesToHex(bound.intent["userScript.program"] as Uint8Array),
      solver_program: bytesToHex(bound.intent["solverScript.program"] as Uint8Array),
      option_program: bytesToHex(bound.intent["optionScript.program"] as Uint8Array),
      side: scriptNumHex(bound.intent.side as bigint),
      collateral: scriptNumHex(bound.intent.collateral as bigint),
      premium: scriptNumHex(bound.intent.premium as bigint),
      deadline: scriptNumHex(bound.intent.deadline as bigint),
      exit: scriptNumHex(bound.intent.exit as bigint),
    },
  };
}

export function reboardVaultDelegation(templateId: string, bound: Bound): Delegation {
  return {
    templateId,
    variables: {
      kind: scriptNumHex(bound.vault.kind as bigint),
      writer_pk: compressedEvenKeyHex(bound.vault.writerPk as Uint8Array),
      holder_pk: compressedEvenKeyHex(bound.vault.holderPk as Uint8Array),
      writer_program: bytesToHex(bound.vault["writerScript.program"] as Uint8Array),
      holder_program: bytesToHex(bound.vault["holderScript.program"] as Uint8Array),
      strike: scriptNumHex(bound.vault.strike as bigint),
      collateral: scriptNumHex(bound.vault.collateral as bigint),
      stake: scriptNumHex(bound.vault.stake as bigint),
      expiry: scriptNumHex(bound.vault.expiry as bigint),
      oracle_pk: compressedEvenKeyHex(bound.vault.oraclePk as Uint8Array),
      backup_pk: compressedEvenKeyHex(bound.vault.backupPk as Uint8Array),
      void_after: scriptNumHex(bound.vault.voidAfter as bigint),
      fallback_delay: scriptNumHex(bound.vault.fallbackDelay as bigint),
      final_exit_delay: scriptNumHex(bound.vault.finalExitDelay as bigint),
    },
  };
}

export function artifactHash(artifact: arkade.ContractArtifact): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(artifact))));
}

export class Executor {
  private readonly url: string;
  private readonly templates = new Map<string, string>();

  private constructor(url: string) {
    this.url = url.replace(/\/+$/, "");
  }

  static async connect(
    url: string,
    keys: { serverKey: Uint8Array; emulatorKey: Uint8Array },
    signal?: AbortSignal,
  ): Promise<Executor | undefined> {
    const clean = url.trim().replace(/\/+$/, "");
    if (!clean) return undefined;
    try {
      const res = await fetch(`${clean}/v1/info`, { signal: signal ?? AbortSignal.timeout(5_000) });
      if (!res.ok) {
        console.warn(`[executor] info ${res.status} from ${clean}`);
        return undefined;
      }
      const info = (await res.json()) as Record<string, string | undefined>;
      const tail = (key = "") => key.trim().toLowerCase().slice(-64);
      if (tail(info.serverPubkey) !== bytesToHex(xOnly(keys.serverKey))) {
        console.warn("[executor] server pubkey mismatch, skipping");
        return undefined;
      }
      if (tail(info.emulatorPubkey) !== bytesToHex(xOnly(keys.emulatorKey))) {
        console.warn("[executor] emulator pubkey mismatch, skipping");
        return undefined;
      }
      return new Executor(clean);
    } catch (err) {
      console.warn("[executor] connect failed:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async ensureTemplate(
    name: string,
    artifact: arkade.ContractArtifact,
    buildTemplate: (artifactId: string) => Record<string, unknown>,
  ): Promise<string | null> {
    const cached = this.templates.get(name);
    if (cached) return cached;
    try {
      const aRes = await fetch(`${this.url}/v1/artifact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: JSON.stringify(executorArtifact(artifact)) }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!aRes.ok) {
        console.warn(`[executor] artifact ${name} ${aRes.status}:`, await aRes.text().catch(() => ""));
        return null;
      }
      const aBody = (await aRes.json()) as { artifact?: { id?: string }; id?: string };
      const artifactId = aBody.artifact?.id ?? aBody.id;
      if (!artifactId) return null;
      const tRes = await fetch(`${this.url}/v1/template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: JSON.stringify(buildTemplate(artifactId)) }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!tRes.ok) {
        console.warn(`[executor] template ${name} ${tRes.status}:`, await tRes.text().catch(() => ""));
        return null;
      }
      const tBody = (await tRes.json()) as { template?: { id?: string }; id?: string };
      const templateId = tBody.template?.id ?? tBody.id;
      if (!templateId) return null;
      this.templates.set(name, templateId);
      return templateId;
    } catch (err) {
      console.warn(`[executor] ensureTemplate ${name} failed:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async delegate(delegation: Delegation): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/v1/delegation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delegation),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        console.warn(`[executor] delegate ${delegation.templateId} ${res.status}:`, await res.text().catch(() => ""));
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[executor] delegate ${delegation.templateId} failed:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
