import { previewFromFields } from "./preview.ts";

type Sample = { price: string; time: number };
type Status = {
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  wallet: string | null;
  balance: string | null;
  address: string | null;
  args: { ctrlTxid: string | null; domain: string; expiryLag: number; readFee: number; adminPk: string | null; exit: number };
  fixings: unknown[];
  samples: number;
  latest: Sample | null;
};

const byId = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

function lines(parent: HTMLElement, tag: string, texts: string[]): void {
  parent.replaceChildren(...texts.map((text) => {
    const el = document.createElement(tag);
    el.className = "mono";
    el.textContent = text;
    return el;
  }));
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${byId("token").value}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
}

async function refresh(): Promise<void> {
  const body = (await (await fetch("/api/status")).json()) as Status;
  const { args } = body;
  const latest = body.latest ? `${body.latest.price} cents at ${body.latest.time}` : "none";
  lines(byId("status"), "p", [
    `Expiry lag ${args.expiryLag}. Read fee ${args.readFee}. Exit ${args.exit}.`,
    `Domain ${args.domain}`,
    `Admin ${args.adminPk ?? "unset"}`,
    `Fund ${body.wallet ?? "unset"}`,
    `Balance ${body.balance ?? "unset"} sats`,
    `Asset ${body.assetId ?? "unset"}`,
    `Deploy ${body.deployTxid ?? "unset"}`,
    `Beacon ${body.address ?? "unset"}`,
    `BEACON_TXID ${body.issueTxid ?? "unset"}`,
    `ctrlTxid ${args.ctrlTxid ?? "unset"}`,
    `Fixings ${body.fixings.length}. Samples ${body.samples}. Latest ${latest}.`,
  ]);
}

function sampleBody(price: string): { price: string; time?: string } {
  const time = byId("sample-time").value.trim();
  return time ? { price, time } : { price };
}

function shown(errorId: string, work: () => Promise<void>): void {
  byId(errorId).textContent = "";
  work().then(refresh).catch((err: Error) => {
    byId(errorId).textContent = err.message;
  });
}

function renderPreview(): void {
  const price = byId("settle-price").value;
  const strike = byId("strike").value;
  const collateral = byId("collateral").value;
  const out = byId("payout");
  if (!price.trim() || !strike.trim() || !collateral.trim()) {
    out.textContent = "";
    return;
  }
  const seen = previewFromFields({ kind: byId("kind").value, price, strike, collateral });
  if ("error" in seen) {
    out.textContent = seen.error;
    return;
  }
  const fold = seen.mode === "split" ? "" : " Dust folded the small leg into the other output.";
  out.textContent = `Holder ${seen.holder} sats. Writer ${seen.writer} sats. Read fee ${seen.readFee} sats.${fold}`;
}

byId("issue").addEventListener("click", () => shown("admin-error", () => post("/api/issue", {})));
byId("recover").addEventListener("click", () => shown("admin-error", () => post("/api/recover", {})));
byId("deploy").addEventListener("click", () => shown("admin-error", () => post("/api/deploy", {})));
for (const id of ["kind", "settle-price", "strike", "collateral"]) {
  byId(id).addEventListener("input", renderPreview);
  byId(id).addEventListener("change", renderPreview);
}
byId("publish-price").addEventListener("click", () => {
  shown("publish-error", async () => {
    const price = byId("settle-price").value.trim();
    const expiry = byId("expiry").value.trim();
    await post("/api/samples", sampleBody(price));
    try {
      await post("/api/publish", { expiry });
    } catch (err) {
      const message = err instanceof Error ? err.message : "publish failed";
      throw new Error(`Sample stored. Publish failed: ${message}`);
    }
  });
});
byId("sample").addEventListener("submit", (event) => {
  event.preventDefault();
  shown("sample-error", () => post("/api/samples", sampleBody(byId("price").value)));
});

void refresh().catch((err: Error) => {
  byId("admin-error").textContent = err.message;
});
