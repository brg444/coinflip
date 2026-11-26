import { action, copyToClipboard, el } from "./dom.ts";
import { int, shortAddress12 } from "./format.ts";

/**
 * Optional `pnpm demo` setup pill and panel that walks through funding the desk float
 * on Mutinynet/regtest until `/demo.json` reports `stage === "ready"`.
 * Disabled on Bitcoin mainnet builds where `__COINFLIP_DEMO__.setup` is absent.
 */

type DemoStatus = {
  stage?: string;
  wallet?: string;
  desk?: {
    address?: string;
    balance?: string;
    need?: string;
  };
};

type StepSpec = {
  title: string;
  note: string;
  address: string;
  balance: string;
  need: string;
  done: boolean;
  busy?: boolean;
};

function setupStep(index: number, { title, note, address, balance, need, done, busy }: StepSpec): HTMLLIElement {
  const item = el("li", done ? "done" : "");
  const head = el("div", "setup-head");
  head.append(el("span", "setup-n", String(index)), el("b", "", title));
  head.append(el("span", done ? "pill ok" : "pill", done ? (busy ? "Setting up" : "Received") : address ? "Waiting" : "Next"));
  item.append(head, el("p", "sub", note));
  if (address && !done) {
    const row = el("div", "setup-addr");
    const code = el("code", "", shortAddress12(address));
    code.title = address;
    row.append(code, action("btn sm quiet", "Copy", (event) => {
      void copyToClipboard(event.currentTarget as HTMLElement, address);
    }));
    item.append(row, el("p", "setup-bal", `${int(BigInt(balance || 0))} of ${int(BigInt(need))} sats`));
  }
  return item;
}

export function startSetupWatch(opts: {
  enabled: boolean;
  networkLabel: string;
  defaultWalletUrl: string;
}): void {
  if (!opts.enabled) return;
  let setupSeen = "";
  let setupOpen = false;

  const pill = () => document.getElementById("setup-pill");
  const panel = () => document.getElementById("demo-setup");

  const toggleSetup = (open = !setupOpen) => {
    setupOpen = open;
    const p = panel();
    const bar = document.getElementById("bar");
    if (p && bar) {
      p.style.top = `${Math.round(bar.getBoundingClientRect().bottom) + 8}px`;
      p.hidden = !open;
    }
    pill()?.setAttribute("aria-expanded", String(open));
  };

  const renderSetup = (next: DemoStatus) => {
    const pillNode = pill();
    const panelNode = panel();
    if (!pillNode || !panelNode) return;
    if (next.stage === "ready") {
      pillNode.hidden = true;
      panelNode.hidden = true;
      return;
    }
    const deskDone = BigInt(next.desk?.balance || 0) >= BigInt(next.desk?.need || 0) / 4n;
    const count = Number(deskDone);
    pillNode.hidden = false;
    document.getElementById("setup-pill-text")?.replaceChildren(el("span", "long", "Fund demo "), `${count}/1`);
    pillNode.setAttribute("aria-label", `Demo setup, ${count} of 1 deposit in`);
    pillNode.setAttribute("aria-expanded", String(setupOpen));
    const steps = el("ol", "setup-steps");
    steps.append(
      setupStep(1, {
        title: "Desk",
        note: next.desk?.address
          ? `Send about ${int(BigInt(next.desk.need || 0))} sats. It pays winning predictions.`
          : "Starting the desk…",
        address: next.desk?.address || "",
        balance: next.desk?.balance || "0",
        need: next.desk?.need || "0",
        done: deskDone,
      }),
    );
    const open = el("a", "textbtn", `Open your ${opts.networkLabel} wallet`);
    open.href = next.wallet || opts.defaultWalletUrl;
    open.target = "_blank";
    open.rel = "noopener";
    const title = el("p", "setup-title", "One deposit before the first prediction");
    title.id = "setup-title";
    const foot = el("p", "setup-foot");
    foot.append(open, " · updates as it lands");
    panelNode.replaceChildren(title, steps, foot);
    panelNode.hidden = !setupOpen;
  };

  const readSetup = async () => {
    let next: DemoStatus | null = null;
    try {
      const res = await fetch("/demo.json", { cache: "no-store" });
      if (res.ok) next = (await res.json()) as DemoStatus;
    } catch {
      next = null;
    }
    if (!next) {
      const p = pill();
      const d = panel();
      if (p) p.hidden = true;
      if (d) d.hidden = true;
      return;
    }
    // The page is rebuilt once the oracle and desk are up; pick that build up when setup finishes.
    if (next.stage === "ready" && setupSeen && setupSeen !== "ready") {
      location.reload();
      return;
    }
    setupSeen = next.stage || "";
    renderSetup(next);
  };

  pill()?.addEventListener("click", () => toggleSetup());
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (setupOpen && !target?.closest("#demo-setup, #setup-pill")) toggleSetup(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && setupOpen) toggleSetup(false);
  });
  void readSetup();
  setInterval(() => {
    if (setupSeen !== "ready") void readSetup();
  }, 4_000);
}
