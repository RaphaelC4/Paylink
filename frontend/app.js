/* Paylink — frontend for the NEAR testnet payment-link contract.
   Static module: no build step, no bundler, no server of our own.
   Reads are unsigned JSON-RPC view calls; writes are signed in the wallet. */

import NearConnect from "@hot-labs/near-connect";
import { CONFIG, ONE_YOCTO, CREATE_STAKE, MAX_DESCRIPTION_BYTES, GAS_DEFAULT, GAS_CLAIM, GAS_FT_CALL } from "./config.js?v=20261109a";

/* The vendored bundle is the package's CommonJS build, so esbuild exposes the
   module namespace as the default export rather than as named exports. */
const { NearConnector } = NearConnect;

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ──────────────────────────────────────────────────────────────── helpers ── */

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 4200);
}

const b64encode = (obj) =>
  btoa(unescape(encodeURIComponent(JSON.stringify(obj))));

function truncate(id, head = 10, tail = 6) {
  if (!id || id.length <= head + tail + 1) return id || "";
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* token integer (base units) -> human string, using config decimals */
function formatAmount(raw, decimals = CONFIG.token.decimals) {
  const d = decimals;
  const s = String(raw).padStart(d + 1, "0");
  const whole = s.slice(0, -d);
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${Number(whole).toLocaleString()}.${frac}` : Number(whole).toLocaleString();
}

/* human string -> token integer (base units) */
function toBaseUnits(human, decimals = CONFIG.token.decimals) {
  const d = decimals;
  const [w = "0", f = ""] = String(human).trim().split(".");
  const frac = (f + "0".repeat(d)).slice(0, d);
  return (BigInt(w || "0") * 10n ** BigInt(d) + BigInt(frac || "0")).toString();
}

/* Split a credited amount into (payee payout, fee), mirroring `split_fee`
   in the contract: fee rounds down, payout + fee always equals the input. */
function splitFee(raw) {
  const amount = BigInt(raw);
  const bps = BigInt(CONFIG.feeBps);
  const denom = 10000n;
  const fee = (amount / denom) * bps + ((amount % denom) * bps) / denom;
  return { payout: amount - fee, fee };
}

const payoutOf = (raw) => splitFee(raw).payout.toString();
const feeOf = (raw) => splitFee(raw).fee.toString();

/* USD value. The token is a USDC test token, pegged 1:1 by definition,
   so this is a fixed rate rather than a market call. */
const usdOf = (raw) =>
  Number(formatAmount(raw).replace(/,/g, "")) * CONFIG.token.usdPrice;

const usd = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/* Indicative naira reference for the pay card — the Lagos story made visible.
   Fetched once from a public keyless FX endpoint; DISPLAY ONLY: on any
   failure the line stays hidden and the pay flow never notices it exists. */
let fxRate = null;
let fxPending = null;

function loadFx() {
  if (!fxPending) {
    fxPending = fetch(CONFIG.fx.url)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const n = Number(d && d.rates && d.rates[CONFIG.fx.quote]);
        if (Number.isFinite(n) && n > 0) fxRate = n;
        return fxRate;
      })
      .catch(() => null);
  }
  return fxPending;
}

function paintNgn(root, usdValue) {
  const el = root.querySelector("#payNgn");
  if (!el) return;
  const draw = () => {
    if (!fxRate) { el.hidden = true; return; }
    const naira = Math.round(usdValue * fxRate).toLocaleString("en-US");
    el.innerHTML = `<span class="approx" aria-hidden="true">&asymp;</span><span>&#8358;${naira}</span><span class="fx-note">indicative FX</span>`;
    el.hidden = false;
  };
  draw();
  if (!fxRate) loadFx().then(draw);
}

function timeAgo(ms) {
  if (!ms) return "–";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* Expiry is *derived* here from the device clock; the contract enforces it
   independently and refunds a payment to an expired link. */
const statusOf = (link) => {
  if (link.status !== "OPEN") return link.status;
  if (link.expires_at && Number(link.expires_at) > 0 && Date.now() > Number(link.expires_at)) {
    return "EXPIRED";
  }
  return "OPEN";
};

const STATUS_PILL = {
  OPEN: "pill open",
  PAID: "pill paid",
  CLAIMED: "pill claimed",
  EXPIRED: "pill expired",
};

/* A wallet rejects in its own words. Turn the common ones into something a
   person can act on instead of a raw error string. */
function friendly(err) {
  const m = String(err?.message || err || "");
  if (!m) return "Something went wrong.";
  if (/reject|denied|cancel|declin|user closed|dismiss/i.test(m)) {
    return "You rejected the request in your wallet. Nothing was sent.";
  }
  /* NEP-141's `ft_transfer` panics with exactly this when the PAYER holds no
     tokens. It reads like a gas problem and sends people to check their NEAR
     balance, which is the wrong balance entirely — the payer needs USDC and
     NEAR only covers the fee. Phrased to exclude near-api-js's own wording
     ("Account <id> doesn't have enough balance"), which IS a NEAR problem. */
  if (/The account doesn't have enough balance|ERR insufficient balance/i.test(m)) {
    return `That wallet does not have enough ${CONFIG.token.symbol} for this payment. NEAR only covers the gas.`;
  }
  /* near-api-js's own wording for a genuine NEAR shortfall. Deliberately
     requires the account id after "Account", so it cannot collide with the
     NEP-141 string above ("The account doesn't have enough balance"). */
  if (/insufficient|LackBalance|deposit.*NEAR|0 NEAR|Account \S+ doesn't have enough balance/i.test(m)) {
    return "That wallet does not have enough NEAR to cover the deposit and gas.";
  }
  /* Must come before the "does not exist" branch below: the account exists, the
     key the wallet is holding for it does not. */
  if (/access key.*does not exist|InvalidAccessKey/i.test(m)) {
    return "Your wallet is using an old key for this account. Sign out, then reconnect it.";
  }
  if (/23504|does not exist|UnknownAccount/i.test(m)) {
    return "That account does not exist on NEAR testnet.";
  }
  if (/429|rate.?limit|TooManyRequests/i.test(m)) {
    return "The network is busy. Give it a moment and try again.";
  }
  /* A rate-limited or unreachable RPC answers without CORS headers, so the
     browser never sees the status code and JS only gets "Failed to fetch". */
  if (/failed to fetch|networkerror|err_failed|load failed/i.test(m)) {
    return "Could not reach the chain. Check your connection and try again.";
  }
  if (/timeout|did not respond/i.test(m)) {
    return "The chain did not respond in time. Try again.";
  }
  return m;
}

/* ───────────────────────────────────────────────────────── appearance ── */

const THEME_KEY = "paylink:theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.getElementById("themeColor");
  if (meta) meta.content = theme === "dark" ? "#0A0A0A" : "#99f7d5";
  const btn = document.getElementById("themeBtn");
  if (btn) {
    const next = theme === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  }
}

function initTheme() {
  let theme = document.documentElement.dataset.theme || "light";
  applyTheme(theme);
  document.getElementById("themeBtn")?.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  });
}

/* ───────────────────────────────────────────────────────── confetti ── */
/* ~40 lines, no dependency, no asset. Respects reduced-motion. */

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const colors = ["#3c91e6", "#010100", "#6fae4b", "#c3ddf7", "#f0f5ea"];
  const parts = Array.from({ length: 96 }, () => ({
    x: w / 2, y: h * 0.4,
    vx: (Math.random() - 0.5) * 14,
    vy: Math.random() * -12 - 3,
    gw: 5 + Math.random() * 6,
    gh: 8 + Math.random() * 9,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.36,
    c: colors[(Math.random() * colors.length) | 0],
  }));

  let raf = 0;
  let prev = performance.now();
  const tick = (now) => {
    const dt = Math.min(34, now - prev) / 16.67;
    prev = now;
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    for (const p of parts) {
      p.vy += 0.45 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y < h + 60) alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.gw / 2, -p.gh / 2, p.gw, p.gh);
      ctx.restore();
    }
    if (alive) raf = requestAnimationFrame(tick);
    else { cancelAnimationFrame(raf); canvas.remove(); }
  };
  raf = requestAnimationFrame(tick);
  setTimeout(() => { cancelAnimationFrame(raf); canvas.remove(); }, 6000);
}

/* ──────────────────────────────────────────────────────────── copy ── */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard API is blocked on insecure origins — fall back to a selection */
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/* ───────────────────────────────────────────────────────────── RPC (read) ── */

const RPC_TIMEOUT_MS = 12_000;

async function rpc(method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error.data || body.error.message || "rpc error");
    return body.result;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("The chain did not respond in time.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Unsigned view call against a contract. */
async function view(accountId, methodName, args = {}) {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: b64encode(args),
  });
  if (result.error) throw new Error(result.error);
  const buf = result.result;
  if (!buf || !buf.length) return null;
  /* JSON-RPC returns a contract's return value as an array of byte values, not
     as a base64 string. Decoding with TextDecoder (rather than spreading the
     array into String.fromCharCode) keeps this safe for large responses — a
     long ledger would blow the argument limit of a spread call. */
  const text = new TextDecoder().decode(Uint8Array.from(buf));
  return JSON.parse(text);
}

const V = {
  getLink: (id) => view(CONFIG.contractId, "get_link", { link_id: id }),
  byCreator: (who) => view(CONFIG.contractId, "get_links_by_creator", { creator: who }),
  isTokenAllowed: (token) => view(CONFIG.contractId, "is_token_allowed", { token }),
  feeBps: () => view(CONFIG.contractId, "fee_bps", {}),
  ftMetadata: (token) => view(token, "ft_metadata", {}),
  ftBalanceOf: (who, token = CONFIG.tokenId) => view(token, "ft_balance_of", { account_id: who }),
};

/* ──────────────────────────────────────────────────────────────── wallet ── */

const connector = new NearConnector({ network: CONFIG.network, autoConnect: true });
let accountId = null;
/* The invoice currently on screen, kept so a wallet connect/disconnect can
   repaint the pay actions without re-reading the chain. */
let lastPayLink = null;
/* Set once this session has seen the payment land, so the success state and
   the confetti fire exactly once rather than on every re-render. */
let celebrated = false;

async function refreshWallet() {
  try {
    const wallet = await connector.wallet();
    const accounts = await wallet.getAccounts();
    accountId = accounts.length ? accounts[0].accountId : null;
  } catch {
    accountId = null;
  }
  paintWallet();
}

function paintWallet() {
  const label = $("#walletLabel");
  const dis = $("#walletDisconnect");
  if (accountId) {
    /* State over identity: "Connected" tells the user what they need at a
       glance; the full account id lives in the Account panel. */
    label.textContent = "Connected";
    dis.hidden = false;
    const creator = $("#creatorInput");
    if (creator && !creator.dataset.touched) creator.value = accountId;
  } else {
    label.textContent = "No wallet";
    dis.hidden = true;
  }

  /* The hero's secondary CTA is static markup, so it would keep offering a
     connection the user already has. While connected it becomes "My links"
     and navigates instead (the click route below does the switching). */
  const heroCta = $('.hero-actions [data-wallet="connect"] span');
  if (heroCta) heroCta.textContent = accountId ? "My links" : "Connect wallet";
  /* The two wallet-dependent panels repaint on connect/disconnect rather than
     showing whatever they were built with, and the badge re-reads the chain. */
  if (currentTab === "account") renderAccount();
  if (currentTab === "alerts") renderAlerts();
  refreshBadge();
  /* The pay button depends on whether a wallet is connected: repaint just the
     actions so connecting on a pay page swaps "Connect a wallet to pay" for
     "Pay …" without a reload. */
  if (currentTab === "pay" && lastPayLink) {
    renderPayActions(lastPayLink, statusOf(lastPayLink));
  }
  paintPayTo();
}

async function connectWallet() {
  try {
    await connector.connect();
    await refreshWallet();
    toast(`Connected as ${accountId}`);
  } catch (e) {
    toast(friendly(e));
  }
}

async function signOut() {
  try {
    await connector.disconnect();
  } catch { /* already gone */ }
  accountId = null;
  paintWallet();
  toast("Disconnected");
}

/* NEAR reports a reverted transaction as
   { ActionError: { index, kind: { FunctionCallError: { ExecutionError } } } }.
   The old read looked for `ActionError.error.Kind`, which never exists, so
   `?.` short-circuited to undefined and every on-chain revert surfaced as the
   useless string "transaction failed" — the actual contract message was lost. */
function failureReason(f) {
  if (typeof f === "string") return f;
  const kind = f?.ActionError?.kind || f?.ReceiptFailure?.ActionError?.kind;
  const fc = kind?.FunctionCallError;
  const reason = fc?.ExecutionError || fc?.MethodResolveError;
  if (reason) return String(reason).replace(/^Smart contract panicked:\s*/, "");
  try { return JSON.stringify(f); } catch { return "transaction failed"; }
}

/** Sign and send a function call. Returns the transaction hash. */
async function call(methodName, args, { deposit = "0", gas = GAS_DEFAULT, receiverId } = {}) {
  if (!accountId) throw new Error("Connect a wallet first");
  const wallet = await connector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: receiverId || CONFIG.contractId,
    actions: [{
      type: "FunctionCall",
      params: { methodName, args, gas, deposit },
    }],
  });
  const hash = outcome?.transaction?.hash || outcome?.transaction_outcome?.outcome?.id;
  if (outcome?.status?.Failure) throw new Error(failureReason(outcome.status.Failure));
  return hash;
}

/* Create through the relayer: sign a DelegateAction off-chain — a signature
   costs no gas and no stake — then POST it to the relayer Worker, which wraps
   it in its own transaction and pays the gas AND the 0.01 NEAR storage stake.
   On chain the inner call still runs as this account (predecessor is
   preserved through NEP-366), so the link is created exactly as a direct
   transaction would create it. Returns the relayer's transaction hash — the
   same value `call` returns, so the caller treats both paths identically. */
async function callViaRelayer(methodName, args, { deposit = "0", gas = GAS_DEFAULT } = {}) {
  if (!accountId) throw new Error("Connect a wallet first");
  const wallet = await connector.wallet();
  const res = await wallet.signDelegateActions({
    delegateActions: [{
      signerId: accountId,
      receiverId: CONFIG.contractId,
      actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }],
    }],
  });
  const signed = res?.signedDelegateActions?.[0];
  if (!signed) throw new Error("The wallet did not return a signed delegate action.");

  /* A POST failure surfaces as an error rather than silently retrying the
     direct path: the signature already exists, and making the payee pay is a
     decision, not a fallback. The Worker answers 400/429/503 with a message
     that `friendly()` can render as-is. */
  let r;
  try {
    r = await fetch(CONFIG.relayer.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedDelegateAction: signed }),
    });
  } catch {
    throw new Error("Could not reach the relayer. Nothing was sent — your NEAR is untouched.");
  }
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON reply falls through */ }
  if (!r.ok || !j?.ok) {
    throw new Error(j?.error || `The relayer replied ${r.status}. Nothing was sent.`);
  }
  return j.hash;
}

/* ────────────────────────────────────────────────────────────── routing ── */

const TABS = ["home", "create", "ledger", "alerts", "account"];
let currentTab = "home";

function showPanel(name) {
  $$(".panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });

  /* The section tabs stay on every page, including pay and share — on a phone
     they are the floating bar at the bottom, so there is always a way to move
     without the browser's back button. */
  const tabName = TABS.includes(name) ? name : null;
  $$('[role="tab"][data-tab]').forEach((b) => {
    const on = b.dataset.tab === tabName;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  currentTab = name;

  /* The two header icons light up while their panel is the current one, so
     the desktop chrome reports where you are the way the bar does. */
  $("#bellBtn")?.classList.toggle("on", name === "alerts");
  $("#acctBtn")?.classList.toggle("on", name === "account");

  /* Rendered on show rather than at load: both depend on the connected wallet
     and both change while the page is open. */
  if (name === "alerts") renderAlerts();
  if (name === "account") renderAccount();
}

function go(name, { push = true } = {}) {
  if (name === "pay" || name === "ready") return; // both need an id
  if (push && location.hash.slice(1) !== name) location.hash = name;
  showPanel(name);
  window.scrollTo({ top: 0, behavior: document.documentElement.classList.contains("flat") ? "auto" : "smooth" });
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: document.documentElement.classList.contains("flat") ? "auto" : "smooth" });
}

async function openPay(id) {
  showPanel("pay");
  if (location.hash.slice(1) !== `pay/${id}`) location.hash = `pay/${id}`;
  scrollToTop();
  await renderPay(id);
}

async function openReady(id) {
  showPanel("ready");
  if (location.hash.slice(1) !== `ready/${id}`) location.hash = `ready/${id}`;
  scrollToTop();
  await renderReady(id);
}

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("pay/")) { openPay(h.slice(4)); return; }
  if (h.startsWith("ready/")) { openReady(h.slice(6)); return; }
  const name = TABS.includes(h) ? h : "home";
  showPanel(name);
  if (name === "ledger" && $("#creatorInput").value) loadLedger();
}

/* ───────────────────────────────────────────────────────────── create ── */

function newLinkId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return "lnk-" + Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

const payUrlFor = (id) =>
  `${location.origin}${location.pathname}#pay/${encodeURIComponent(id)}`;

/* The "paid to" row mirrors `predecessor_account_id`: create_link issues the
   link to whoever signs, so this is display only — it cannot be edited. */
function paintPayTo() {
  const field = $("#payToField");
  const addr = $("#payToAddr");
  const badge = $("#payToBadge");
  if (!field || !addr) return;
  if (accountId) {
    field.classList.remove("empty");
    addr.textContent = accountId;
    addr.title = accountId;
    badge.hidden = false;
  } else {
    field.classList.add("empty");
    addr.textContent = "connect a wallet";
    addr.removeAttribute("title");
    badge.hidden = true;
  }
}

async function handleCreate(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const description = form.description.value.trim();
  const amountRaw = form.amount.value.trim();
  const hours = Number(form.expires.value);

  if (!amountRaw || Number(amountRaw) <= 0) return toast("Enter an amount greater than zero");
  if (!accountId) { toast("Connect a wallet first"); return connectWallet(); }

  /* The note is optional in this form but not on chain: `create_link` rejects
     an empty description, and it counts UTF-8 BYTES (Rust `String::len`), not
     the characters `maxlength` counts — 200 emoji are 800 bytes on chain and
     would revert. An empty note becomes the phrase the share page already
     falls back to, so leaving it blank still works. */
  const note = description || "Payment request";
  const noteBytes = new TextEncoder().encode(note).length;
  if (noteBytes > MAX_DESCRIPTION_BYTES) {
    return toast(`That note is ${noteBytes} bytes on chain — the limit is ${MAX_DESCRIPTION_BYTES}. Shorten it.`);
  }

  const amount = toBaseUnits(amountRaw);
  if (BigInt(amount) <= 0n) return toast("Enter an amount greater than zero");
  const linkId = newLinkId();
  /* Contract stores `expires_at: Option<u64>` in **milliseconds**. Raw u64
     serializes as a JSON number (not a string), and ms values stay well
     inside Number's exact-integer range. */
  const expiresAt = hours > 0 ? Date.now() + hours * 3600_000 : null;

  const args = {
    link_id: linkId,
    amount,
    token: CONFIG.tokenId,
    description: note,
    expires_at: expiresAt,
  };

  const line = $("#createResult");
  const btn = $("#createBtn");
  const label = btn.querySelector("span");
  line.hidden = false;
  line.className = "tx-line pending";
  line.textContent = `signing create_link(${linkId})…`;
  btn.disabled = true;
  label.textContent = "Creating link…";

  try {
    /* Relayer first, gated on deploy state (empty endpoint = direct, exactly
       as before). The wallet must advertise signDelegateActions — wallets
       that cannot sign delegates fall back to the direct transaction, where
       the payee pays gas + stake (the corner case, not the default). */
    let hash;
    if (CONFIG.relayer.endpoint) {
      const relayerWallet = await connector.wallet();
      hash = typeof relayerWallet.signDelegateActions === "function"
        ? await callViaRelayer("create_link", args, { deposit: CREATE_STAKE })
        : await call("create_link", args, { deposit: CREATE_STAKE });
    } else {
      hash = await call("create_link", args, { deposit: CREATE_STAKE });
    }
    line.className = "tx-line ok";
    line.innerHTML = `created · <a class="mono" href="${CONFIG.explorer}/transactions/${hash}" target="_blank" rel="noopener">${truncate(hash, 12, 8)}</a>`;
    toast("Link created");
    form.reset();
    paintPayTo();
    await openReady(linkId);
  } catch (err) {
    const msg = friendly(err);
    line.className = "tx-line err";
    line.textContent = msg;
    toast(msg);
  } finally {
    btn.disabled = false;
    label.textContent = "Create link";
  }
}

/* ─────────────────────────────────────────────────── share / ready page ── */

const SHARE_ICONS = {
  whatsapp: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M14 7.7a5.9 5.9 0 0 1-8.7 5.2L2 14l1.1-3.2A5.9 5.9 0 1 1 14 7.7z"/><path d="M6 5.6c.3-.4.6-.2.8.1l.4.7c.1.2 0 .4-.1.5l-.3.2c-.1.1-.1.3 0 .4.3.5.8 1 1.3 1.3.1.1.3.1.4 0l.2-.3c.1-.1.3-.2.5-.1l.7.4c.3.2.4.5.1.8-.3.4-.9.6-1.5.5a5 5 0 0 1-3.3-3.3c-.1-.6.1-1.2.5-1.5z" fill="currentColor" stroke="none"/></svg>`,
  telegram: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 1.5 1.5 6.8l4.4 1.8 1.8 4.4z"/><path d="M14.5 1.5 5.9 8.6"/></svg>`,
  email: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.8" y="3.5" width="12.4" height="9" rx="1.6"/><path d="m2.2 4.6 5.8 4 5.8-4"/></svg>`,
  more: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12" cy="8" r="1.3"/></svg>`,
};

function shareRow(url, text) {
  const q = (s) => encodeURIComponent(s);
  const buttons = [
    { label: "WhatsApp", icon: SHARE_ICONS.whatsapp, href: `https://wa.me/?text=${q(text + " " + url)}` },
    { label: "Telegram", icon: SHARE_ICONS.telegram, href: `https://t.me/share/url?url=${q(url)}&text=${q(text)}` },
    { label: "Email", icon: SHARE_ICONS.email, href: `mailto:?subject=${q(text)}&body=${q(url)}` },
  ];
  const html = buttons.map((b) => `
    <a class="share-btn" href="${esc(b.href)}" target="_blank" rel="noopener noreferrer">
      ${b.icon}<span>${b.label}</span>
    </a>`).join("");
  /* The OS share sheet is strictly better when the browser offers it. */
  const native = typeof navigator.share === "function"
    ? `<button class="share-btn" type="button" data-native-share="${esc(url)}" data-share-text="${esc(text)}">${SHARE_ICONS.more}<span>More</span></button>`
    : "";
  return html + native;
}

/* Built in the browser with a vendored MIT QR encoder — no image request, no
   third-party service, works offline. Returns "" if the library is missing. */
function qrMarkup(text) {
  if (typeof window.qrcode !== "function") return "";
  try {
    const qr = window.qrcode(0, "M"); // 0 = pick the type number automatically
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch { return ""; }
}

/* The QR only needs the id in the route, so it is built from that rather than
   from the chain read — the one thing this page exists to hand over must not
   disappear when the RPC is slow or rate-limited. */
const qrBlock = (qr) => qr
  ? `<div class="qr-tile" role="img" aria-label="QR code for this payment link">${qr}</div>
     <p class="qr-cap">Scan to open the payment page on any phone.</p>`
  : "";

/* The copy field needs only the URL, so it is shared between the loaded page
   and the chain-failure state — neither of them waits on the RPC. The social
   share row is not: those buttons embed the amount and description. */
const shareUrlField = (payUrl) => `
  <div class="share-url">
    <code title="${esc(payUrl)}">${esc(payUrl)}</code>
    <button class="copy" type="button" data-copy-text="${esc(payUrl)}" data-copy-label="Link copied!" title="Copy payment link" aria-label="Copy payment link">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
      <span>Copy</span>
    </button>
  </div>`;

function readyError(title, detail, id = "", qrHtml = "", payUrl = "") {
  return `
    <div class="ready-top"><div class="ready-title">${esc(title)}</div></div>
    <div class="share-grid">
      <div class="share-main">
        <p class="sub">${esc(detail)}</p>
        ${payUrl ? shareUrlField(payUrl) : ""}
      </div>
      ${qrHtml ? `<div class="qr-col">${qrHtml}</div>` : ""}
    </div>
    <div class="ready-actions">
      ${id ? `<button class="btn btn-sm" type="button" data-retry-ready="${esc(id)}"><span>Try again</span></button>` : ""}
      <button class="btn btn-sm ghost" type="button" data-go="create"><span>Create a link</span></button>
    </div>`;
}

async function renderReady(id) {
  const card = $("#readyCard");
  const payUrl = payUrlFor(id);
  const qr = qrMarkup(payUrl);

  if (card.dataset.id !== id) {
    card.dataset.id = id;
    card.innerHTML = `
      <div class="ready-top">
        <div class="skeleton-block sk-lg" aria-hidden="true"></div>
      </div>
      <div class="share-grid">
        <div class="share-main">
          <div class="skeleton-block" aria-hidden="true"></div>
          <div class="skeleton-block sk-w60" aria-hidden="true"></div>
          <div class="skeleton-block sk-w60" aria-hidden="true"></div>
        </div>
        <div class="qr-col">${qrBlock(qr)}</div>
      </div>
      <p class="sr-status" role="status">Reading the chain&hellip;</p>`;
  }

  let link;
  try {
    link = await V.getLink(id);
  } catch (err) {
    /* Keep the QR and the copy field: neither depends on the chain. */
    card.innerHTML = readyError("Could not read the chain", friendly(err), id, qrBlock(qr), payUrl);
    return;
  }
  if (!link) {
    card.innerHTML = readyError("No such link", `Nothing on chain with id ${id}.`);
    return;
  }

  const st = statusOf(link);
  const note = link.description || "Payment request";
  const shareText = `${note} — ${formatAmount(link.amount)} ${CONFIG.token.symbol}`;
  const expires = link.expires_at && Number(link.expires_at)
    ? new Date(Number(link.expires_at)).toLocaleDateString()
    : "never";

  card.innerHTML = `
    <div class="ready-top">
      <div class="ready-title">
        ${esc(note)}
        <span>${formatAmount(link.amount)} ${esc(CONFIG.token.symbol)} &middot; requested by ${esc(truncate(link.creator, 18, 6))}</span>
      </div>
      <span class="${STATUS_PILL[st]}">${st === "OPEN" ? "UNPAID" : st}</span>
    </div>

    <div class="share-grid">
      <div class="share-main">
        ${shareUrlField(payUrl)}

        <div class="share-btns">${shareRow(payUrl, shareText)}</div>

        <div class="detail-grid">
          <div class="net-cell"><span class="net-k">amount</span><span class="net-v mono">${formatAmount(link.amount)} ${esc(CONFIG.token.symbol)}</span></div>
          <div class="net-cell"><span class="net-k">you receive</span><span class="net-v mono">${formatAmount(payoutOf(link.amount))} ${esc(CONFIG.token.symbol)}</span></div>
          <div class="net-cell"><span class="net-k">expires</span><span class="net-v mono">${esc(expires)}</span></div>
          <div class="net-cell"><span class="net-k">fee</span><span class="net-v mono">${CONFIG.feeBps / 100}%</span></div>
        </div>
      </div>

      <div class="qr-col">
        ${qr
          ? `<div class="qr-tile" role="img" aria-label="QR code for this payment link">${qr}</div>
             <p class="qr-cap">Scan to open the payment page on any phone.</p>`
          : `<div class="qr-tile" aria-hidden="true"></div>
             <p class="qr-cap">QR unavailable — copy the link instead.</p>`}
      </div>
    </div>

    <div class="ready-actions">
      <button class="btn btn-sm" type="button" data-open-pay="${esc(link.link_id)}"><span>Open payment page</span></button>
      <button class="btn btn-sm ghost" type="button" data-go="create"><span>Create another</span></button>
      <button class="btn btn-sm ghost" type="button" data-go="ledger"><span>My links</span></button>
    </div>`;
}

/* ────────────────────────────────────────────────────────── AI parsing ── */
/* The model only proposes form values. Everything it returns is checked here,
   in code, against the chain — and nothing it returns can reach the contract
   without the user pressing "Create link". */

function aiNote(msg, kind = "") {
  const el = $("#aiNote");
  el.textContent = msg || "";
  el.className = `ai-note ${kind}`.trim();
}

const AI_AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const MAX_BASE_UNITS = 10n ** 12n; // 1,000,000 USDC

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });
}

async function parseInvoice() {
  const text = $("#aiText").value.trim();
  const file = $("#aiFile").files[0];

  if (!text && !file) return aiNote("Paste some text or attach a file first.", "warn");
  if (!CONFIG.parseEndpoint) return aiNote("No parse endpoint configured.", "warn");

  const btn = $("#aiFill");
  btn.disabled = true;
  aiNote("Reading the request…");

  try {
    const body = file
      ? { filename: file.name, mime: file.type || "application/octet-stream", data: await fileToBase64(file) }
      : { text };

    const res = await fetch(CONFIG.parseEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    /* The Worker writes a usable message for every failure — "Text is too long",
       "Unsupported file type", "GEMINI_API_KEY is not set". Surface that rather
       than a bare status number. */
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error || `The parser could not read that (error ${res.status}).`);
    }
    const parsed = await res.json();
    await applyParsed(parsed);
  } catch (err) {
    const msg = String(err?.message || "");
    aiNote(/failed to fetch|networkerror|load failed/i.test(msg)
      ? "Could not reach the parser service. Check your connection and try again."
      : msg || "Could not read that request.", "warn");
  } finally {
    btn.disabled = false;
  }
}

/** Validate the model's output, then write it into the form. */
async function applyParsed(p) {
  const problems = [];
  const notes = [];

  /* amount — must be a plain decimal we can convert without losing units */
  const amount = String(p?.amount ?? "").trim().replace(/,/g, "");
  let amountOk = false;
  if (AI_AMOUNT.test(amount)) {
    const base = BigInt(toBaseUnits(amount));
    amountOk = base > 0n && base <= MAX_BASE_UNITS;
  }
  if (!amountOk) problems.push("amount");

  /* token — checked against the chain's allowlist, never against the AI */
  const claimed = String(p?.token ?? "").trim();
  const norm = (s) => s.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
  let tokenOk = false;
  if (claimed) {
    const allowed = await V.isTokenAllowed(claimed).catch(() => false);
    const aliases = CONFIG.token.aliases || [];
    const isOurs =
      claimed === CONFIG.tokenId ||
      norm(claimed) === norm(CONFIG.token.symbol) ||
      aliases.some((a) => norm(a) === norm(claimed));
    tokenOk = Boolean(allowed) || isOurs;
    if (!tokenOk) {
      problems.push("token");
      notes.push(`That request is in ${claimed}. This deployment only accepts ${CONFIG.token.symbol}.`);
    }
  } else {
    tokenOk = true; // no token named; the form's single token applies
  }

  /* description */
  const description = String(p?.description ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  /* expiry */
  let hours = Number(p?.expires_in_hours);
  hours = Number.isFinite(hours) && hours > 0 && hours <= 8760 ? Math.round(hours) : 0;

  /* payee — create_link takes predecessor_account_id, so the invoice is always
     issued to the connected wallet. A different payee in the document is
     surfaced, never used. */
  const payee = String(p?.payee ?? "").trim();
  if (payee && accountId && payee.toLowerCase() !== accountId.toLowerCase()) {
    notes.push(`The document names ${payee}; this link will be issued to your wallet (${accountId}).`);
  } else if (payee && !accountId) {
    notes.push(`The document names ${payee}. Connect that wallet, or the link goes to whichever wallet signs.`);
  }

  if (problems.includes("amount")) {
    aiNote("Could not find a usable amount in that request. Check it and enter one by hand.", "warn");
    return;
  }
  if (problems.includes("token")) {
    aiNote(notes.join(" "), "warn");
    return;
  }

  $("#description").value = description;
  $("#amount").value = amount;
  const expOpt = hours === 0 ? "0" : hours <= 36 ? "24" : hours <= 120 ? "72" : "168";
  $("#expires").value = expOpt;

  const filled = ["amount", description ? "description" : ""].filter(Boolean).length;
  const expNote = hours > 0 ? ` Expiry set to ${expOpt === "24" ? "24 hours" : expOpt === "72" ? "3 days" : "7 days"}.` : "";
  aiNote(
    `Filled ${filled} field${filled === 1 ? "" : "s"}. Check the amount before creating.${expNote}${notes.length ? " " + notes.join(" ") : ""}`,
    notes.length ? "warn" : "ok"
  );
  $("#amount").focus();
}

/* ─────────────────────────────────────────────────────────── dashboard ── */

let ledgerRows = [];
let ledgerFilter = "all";

const FILTERS = {
  all: { label: "", match: () => true },
  open: { label: "unpaid", match: (l) => statusOf(l) === "OPEN" },
  paid: { label: "paid", match: (l) => { const s = statusOf(l); return s === "PAID" || s === "CLAIMED"; } },
  expired: { label: "expired", match: (l) => statusOf(l) === "EXPIRED" },
};

const SKELETON_ROWS = Array.from({ length: 4 }, () => `
  <div class="row-main" aria-hidden="true">
    <span class="c-invoice"><span class="skeleton-block sk-w60"></span><span class="skeleton-block sk-w30"></span></span>
    <span class="c-amount"><span class="skeleton-block sk-w60"></span></span>
    <span class="c-usd"><span class="skeleton-block sk-w60"></span></span>
    <span class="c-status"><span class="skeleton-block sk-w60"></span></span>
    <span class="c-payer"><span class="skeleton-block sk-w60"></span></span>
    <span class="c-action"><span class="skeleton-block sk-w60"></span></span>
  </div>`).join("");

async function loadLedger() {
  const who = $("#creatorInput").value.trim();
  if (!who) return toast("Enter an account above");
  const list = $("#ledgerList");
  list.innerHTML = SKELETON_ROWS;
  $("#tableCreator").textContent = who;
  $("#tableCount").textContent = "reading…";
  $("#ledgerStats").hidden = true;
  $("#ledgerFilters").hidden = true;

  try {
    const rows = ((await V.byCreator(who)) || []).slice().reverse();
    ledgerRows = rows;
    renderLedger();
  } catch (err) {
    list.innerHTML = `<div class="empty-line">${esc(friendly(err))}</div>`;
    $("#tableCount").textContent = "–";
  }
}

function renderLedger() {
  const rows = ledgerRows;
  const list = $("#ledgerList");
  const counts = { all: rows.length, open: 0, paid: 0, expired: 0 };
  let received = 0n;
  let awaiting = 0n;

  for (const l of rows) {
    const st = statusOf(l);
    if (st === "OPEN") { counts.open++; awaiting += BigInt(l.amount); }
    else if (st === "EXPIRED") counts.expired++;
    else {
      counts.paid++;
      /* Only money that actually reached the payee counts as received. */
      if (st === "CLAIMED") received += BigInt(l.paid_amount || l.amount);
    }
  }

  $("#statReceived").textContent = `${formatAmount(received.toString())} ${CONFIG.token.symbol}`;
  $("#statReceived").classList.toggle("pos", received > 0n);
  $("#statOpen").textContent = `${formatAmount(awaiting.toString())} ${CONFIG.token.symbol}`;
  $("#statCount").textContent = String(rows.length);
  $("#ledgerStats").hidden = false;
  $("#ledgerFilters").hidden = false;

  for (const key of Object.keys(FILTERS)) {
    const el = document.querySelector(`.f-n[data-f="${key}"]`);
    if (el) el.textContent = counts[key];
  }
  $("#tableCount").textContent = `${rows.length} link${rows.length === 1 ? "" : "s"}`;

  if (!rows.length) {
    list.innerHTML = `
      <div class="empty-line">
        No links for this account yet.
        <div style="margin-top:.9rem"><button class="btn btn-sm" type="button" data-go="create"><span>Create your first link</span></button></div>
      </div>`;
    return;
  }

  const visible = rows.filter(FILTERS[ledgerFilter].match);
  if (!visible.length) {
    const what = FILTERS[ledgerFilter].label || "that";
    list.innerHTML = `
      <div class="empty-line">
        Nothing ${esc(what)} right now.
        <div style="margin-top:.9rem"><button class="chip-btn" type="button" data-filter="all">Show all</button></div>
      </div>`;
    return;
  }
  list.innerHTML = visible.map(ledgerRow).join("");
}

function ledgerRow(link) {
  const st = statusOf(link);
  const canClaim = st === "PAID" && accountId;
  return `
    <div class="row-main" data-link="${esc(link.link_id)}">
      <span class="c-invoice" title="${esc(link.description)}">
        <span class="inv-desc">${esc(link.description || "No description")}</span>
        <span class="inv-id">${esc(link.link_id)}</span>
      </span>
      <span class="c-amount">${formatAmount(link.amount)} <span class="tiny">${esc(CONFIG.token.symbol)}</span></span>
      <span class="c-usd">${usd(usdOf(link.amount))}</span>
      <span class="c-status"><span class="${STATUS_PILL[st]}">${st}</span></span>
      <span class="c-payer">${link.paid_by ? truncate(link.paid_by, 8, 4) : "—"}</span>
      <span class="c-action">
        ${canClaim
          ? `<button class="chip-btn" type="button" data-claim="${esc(link.link_id)}">Release</button>`
          : `<button class="chip-btn" type="button" data-open-pay="${esc(link.link_id)}">Open</button>`}
      </span>
    </div>`;
}

function exportCsv() {
  if (!ledgerRows.length) return toast("Load a ledger first");
  const head = ["link", "amount", "token", "usd", "status", "payer", "paid at", "description"];
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(",")];
  for (const l of ledgerRows) {
    lines.push([
      l.link_id,
      formatAmount(l.amount),
      CONFIG.token.symbol,
      usdOf(l.amount).toFixed(2),
      statusOf(l),
      l.paid_by || "",
      l.paid_at ? new Date(Number(l.paid_at)).toISOString() : "",
      l.description,
    ].map(cell).join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `paylink-${$("#creatorInput").value.trim() || "ledger"}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("CSV downloaded");
}

/* ───────────────────────────────────────────────────────────────── pay ── */

function timeline(st) {
  if (st === "EXPIRED") {
    return `
      <div class="timeline one">
        <div class="tl-step now warm">
          <span class="tl-bar"></span>
          <span class="tl-label">Expired &mdash; the contract refuses payment</span>
        </div>
      </div>`;
  }
  const idx = { OPEN: 0, PAID: 1, CLAIMED: 2 }[st] ?? 0;
  const labels = ["Open", "Paid", "Claimed"];
  return `
    <div class="timeline">
      ${labels.map((label, i) => {
        const cls = i < idx ? "done" : i === idx ? "now" : "";
        return `<div class="tl-step ${cls}"><span class="tl-bar"></span><span class="tl-label">${label}</span></div>`;
      }).join("")}
    </div>`;
}

function payError(title, detail, id = "") {
  return `
    <div class="pay-top"><span class="eyebrow">payment request</span></div>
    <h2 class="h3">${esc(title)}</h2>
    <p class="sub" style="margin-top:.6rem">${esc(detail)}</p>
    ${id ? `<div class="pay-actions"><button class="btn btn-sm" type="button" data-retry-pay="${esc(id)}"><span>Try again</span></button></div>` : ""}`;
}

const PAY_SKELETON = `
  <span class="eyebrow">payment request</span>
  <div class="skeleton-block sk-w30" aria-hidden="true"></div>
  <div class="skeleton-block sk-lg" aria-hidden="true"></div>
  <div class="skeleton-block sk-w60" aria-hidden="true"></div>
  <div class="skeleton-block sk-w50" aria-hidden="true"></div>`;

/* ─────────────────────────────────────────────────────── line items ──
   A note written as "Label — price; Label — price" is a list on the payment
   card, and only then: every segment has to parse AND the prices have to add
   up to exactly what the link asks for (BigInt, in base units — no float
   drift). One unparseable segment, or a sum that misses, and the note renders
   as the plain sentence it has always been. */
function lineItems(desc, rawAmount, decimals = CONFIG.token.decimals) {
  const parts = String(desc || "").split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const want = BigInt(rawAmount);
  const items = [];
  let sum = 0n;
  for (const p of parts) {
    const m = /^(.+?)\s*[—–-]\s*(\d+(?:\.\d+)?)$/.exec(p);
    if (!m) return null;
    const label = m[1].trim();
    if (!label) return null;
    const base = BigInt(toBaseUnits(m[2], decimals));
    if (base <= 0n) return null;
    items.push({ label, base });
    sum += base;
  }
  return sum === want ? items : null;
}

/* The card's "for" line: the list when the note itemises, the note itself
   otherwise. Escaped either way — the labels are user text. */
function payNoteHtml(link) {
  const items = lineItems(link.description, link.amount);
  if (!items) {
    return link.description ? `<p class="pay-desc"><b>for</b>${esc(link.description)}</p>` : "";
  }
  const rows = items.map((i) => `
          <div class="pi-row"><span class="pi-l">${esc(i.label)}</span><span class="pi-p">${formatAmount(String(i.base))} ${esc(CONFIG.token.symbol)}</span></div>`).join("");
  return `
        <div class="pay-items">
          <span class="pi-h">for</span>${rows}
        </div>`;
}

async function renderPay(id) {
  const card = $("#payCard");
  delete card.dataset.status;
  lastPayLink = null;
  /* A swap quote from a previous visit must not keep polling into a card
     that no longer exists. */
  clearInterval(fundPollTimer);
  fundPollTimer = null;

  /* Only flash the skeleton when the link actually changes — a status refresh
     on the same invoice should not blank out a card the user is reading. */
  if (card.dataset.id !== id) {
    card.dataset.id = id;
    celebrated = false;
    delete card.dataset.confetti;
    card.innerHTML = `${PAY_SKELETON}<p class="sr-status" role="status">Reading the chain&hellip;</p>`;
  }

  let link;
  try {
    link = await V.getLink(id);
  } catch (err) {
    card.innerHTML = payError("Could not read the chain", friendly(err), id);
    return;
  }
  if (!link) {
    card.innerHTML = payError("No such link", `Nothing on chain with id ${id}.`);
    return;
  }
  if (link.token !== CONFIG.tokenId) {
    card.innerHTML = payError(
      "Unsupported token",
      `This link is denominated in ${link.token}, which this deployment does not accept.`
    );
    return;
  }

  const st = statusOf(link);
  const amount = formatAmount(link.amount);
  const value = usdOf(link.amount);
  const credited = link.paid_amount || link.amount;
  const landed = st === "PAID" || st === "CLAIMED";
  const mine = !!accountId && accountId === link.creator;

  /* Fire the confetti once, the first time we render the paid state. */
  if (celebrated && landed && card.dataset.confetti !== "1") {
    card.dataset.confetti = "1";
    confetti();
  }

  const success = celebrated && landed ? `
    <div class="pay-success">
      <span class="chk" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 8.4 6.6 11.4 12.4 5"/></svg>
      </span>
      <div>
        <strong>Paid!</strong>
        <span>${formatAmount(credited)} ${esc(CONFIG.token.symbol)} settled &mdash; ${st === "CLAIMED" ? (mine ? "released to you" : "released to the payee") : "waiting to be released"}.</span>
      </div>
    </div>` : "";

  card.dataset.status = st;
  lastPayLink = link;
  card.innerHTML = `
    ${success}

    <div class="pay-top">
      <div class="pay-who">
        <span class="pay-avatar" aria-hidden="true">${esc((link.creator || "?").charAt(0))}</span>
        <div class="pay-who-txt">
          <strong title="${esc(link.creator)}">${esc(truncate(link.creator, 24, 8))}</strong>
          <span>requests ${amount} ${esc(CONFIG.token.symbol)}</span>
        </div>
      </div>
      <span class="${STATUS_PILL[st]}">${st}</span>
    </div>

    <div class="pay-usd"><span class="approx" aria-hidden="true">&asymp;</span><span>${usd(value)}</span></div>
    <div class="pay-ngn" id="payNgn" hidden></div>
    <div class="pay-token">
      <svg class="coin" aria-hidden="true"><use href="#coin-usdc"/></svg>
      <span>${amount} ${esc(CONFIG.token.symbol)}</span>
    </div>

    ${payNoteHtml(link)}

    ${timeline(st)}

    <div class="pay-actions" id="payActions"></div>

    <details class="tech">
      <summary>Technical details</summary>
      <div class="tech-body">
        <div class="row"><span>link id</span><code>${esc(link.link_id)}</code></div>
        <div class="row"><span>token</span><code>${esc(link.token)}</code></div>
        <div class="row"><span>contract</span><code>${esc(CONFIG.contractId)}</code></div>
        <div class="row"><span>created</span><span>${timeAgo(Number(link.created_at))}</span></div>
        <div class="row"><span>expires</span><span>${link.expires_at && Number(link.expires_at) ? new Date(Number(link.expires_at)).toLocaleString() : "never"}</span></div>
        ${link.paid_by ? `<div class="row"><span>paid by</span><code>${esc(link.paid_by)}</code></div>` : ""}
        ${link.paid_at ? `<div class="row"><span>paid</span><span>${timeAgo(Number(link.paid_at))}</span></div>` : ""}
      </div>
    </details>

    ${st === "OPEN" && !mine ? fundRail() : ""}`;

  paintNgn(card, value);
  renderPayActions(link, st);
  if (st === "OPEN" && !mine) wireFundRail(link);
}

function renderPayActions(link, st) {
  const box = $("#payActions");
  if (!box) return;
  /* Connecting repaints the actions only, never the card — so the shared
     refresher repaints every balance readout (rail, sheet) from here
     whenever one exists. */
  refreshFundBal();
  const credited = link.paid_amount || link.amount;
  const mine = !!accountId && accountId === link.creator;

  if (st === "OPEN") {
    /* The faucet rail is payer tooling, so it is reconciled here as well as
       at full render: this function is the repaint a wallet connect or
       disconnect triggers, and a payee on their own link must never be left
       looking at a payer's funding tools. */
    const rail = $("#fundRail");
    if (mine) {
      if (rail) { rail.remove(); clearInterval(fundPollTimer); fundPollTimer = null; }
      /* The payee's view of their own unpaid link. No Pay button — the
         contract refunds a creator's payment anyway — just the waiting
         state and the tools that get it in front of a payer. */
      const payUrl = payUrlFor(link.link_id);
      const shareText = `${link.description || "Payment request"} — ${formatAmount(link.amount)} ${CONFIG.token.symbol}`;
      /* The share screen carries the QR; this card is where a link you have
         already created gets re-shared from "My links", so it carries one too
         — otherwise a phone never sees the code at all. */
      const qr = qrBlock(qrMarkup(payUrl));
      box.innerHTML = `
        <div class="tx-line pending" role="status">Waiting for payment &mdash; you're the payee here, so the Pay button is for whoever you send this to.</div>
        ${shareUrlField(payUrl)}
        <div class="share-btns">${shareRow(payUrl, shareText)}</div>
        ${qr ? `<div class="qr-col pay-qr">${qr}</div>` : ""}
        <p class="pay-fee">Copy or share the link. It flips to <strong>PAID</strong> the moment their payment lands, and this page shows it happen.</p>`;
      return;
    }
    if (!rail) {
      /* Built while connected as the payee, now connected as somebody else:
         put the payer's rail back where full render leaves it. */
      $("#payCard").insertAdjacentHTML("beforeend", fundRail());
      wireFundRail(link);
    }
    if (!accountId) {
      box.innerHTML = `<button class="btn btn-lg" type="button" data-wallet="connect"><span>Connect a wallet to pay</span></button>`;
    } else {
      box.innerHTML = `<button class="btn btn-lg" type="button" data-pay="${esc(link.link_id)}"><span>Pay ${formatAmount(link.amount)} ${esc(CONFIG.token.symbol)}</span></button>`;
    }
    box.insertAdjacentHTML("beforeend", `
      <p class="pay-fee">they receive <strong>${formatAmount(payoutOf(credited))} ${esc(CONFIG.token.symbol)}</strong> after the ${CONFIG.feeBps / 100}% fee</p>
      <p class="wallet-note">One approval — your wallet signs the payment, and the release happens automatically.</p>`);
    return;
  }

  if (st === "PAID") {
    box.innerHTML = `
      <button class="btn btn-lg" type="button" data-claim="${esc(link.link_id)}">
        <span>Release ${formatAmount(payoutOf(credited))} ${esc(CONFIG.token.symbol)}</span>
      </button>
      <p class="pay-fee">${mine ? "you receive" : "they receive"} <strong>${formatAmount(payoutOf(credited))} ${esc(CONFIG.token.symbol)}</strong> after the ${CONFIG.feeBps / 100}% fee · released automatically by the keeper — the button below is a fallback anyone can press, and the money can only go to ${mine ? "you" : "the payee"}</p>`;
    return;
  }

  if (st === "CLAIMED") {
    box.innerHTML = `<p class="pay-fee">Settled in full. ${formatAmount(payoutOf(credited))} ${esc(CONFIG.token.symbol)} released to ${mine ? "you" : "the payee"}.</p>`;
    return;
  }

  box.innerHTML = `<p class="pay-fee">This link expired. The contract refuses payment on an expired link.</p>`;
}

async function payLink(linkId) {
  const line = $("#payStatus");
  const show = (cls, html) => { line.hidden = false; line.className = `tx-line ${cls}`; line.innerHTML = html; };

  if (!accountId) { toast("Connect a wallet first"); return connectWallet(); }

  let link;
  try { link = await V.getLink(linkId); } catch (e) { return show("err", esc(friendly(e))); }
  if (!link) return show("err", "Link not found");
  /* Backstop for a stale Pay button: the contract refunds this anyway, so
     refuse it here with words instead of letting a doomed signing prompt up. */
  if (accountId && link.creator === accountId) return show("err", "This is your own link — only the person you sent it to can pay it");
  if (statusOf(link) !== "OPEN") return show("err", `This link is ${statusOf(link)}, not open`);

  show("pending", "signing the payment…");
  try {
    /* Send to the invoice's own token, not the configured default — the two
       are the same today, but the link is the source of truth. */
    const hash = await call("ft_transfer_call", {
      receiver_id: CONFIG.contractId,
      amount: String(link.amount),
      msg: linkId,
    }, { receiverId: link.token, deposit: ONE_YOCTO, gas: GAS_FT_CALL });

    show("ok", `Your payment is being confirmed. · <a class="mono" href="${CONFIG.explorer}/transactions/${hash}" target="_blank" rel="noopener">${truncate(hash, 12, 8)}</a>`);
    toast("Payment sent");
    /* Remember it locally: the contract indexes links by creator, not by payer,
       so this is the only way the payer's own activity can be read back. */
    rememberPaid(linkId);
    /* ONE approval ends here — the payer's wallet never signs again. The token
       contract's callback marks the link PAID, and the keeper Worker (every
       minute, from its own gas account) calls `claim`, which can only pay the
       link's creator. This loop merely *watches* the two transitions —
       OPEN→PAID (payment verified) and PAID→CLAIMED (funds released) — speaks
       them to the status line, and stops when the chain confirms settlement.
       The Release button stays on the card as manual recovery if the keeper
       is ever down. Read errors keep the loop going; none of them re-prompt
       the wallet. */
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let st = null;
      for (let i = 0; i < 10; i++) {
        await sleep(1500);
        const fresh = await V.getLink(linkId).catch(() => null);
        if (fresh) {
          st = statusOf(fresh);
          if (st === "PAID" || st === "CLAIMED") break;
        }
      }
      if (st === "PAID") {
        celebrated = true;   // renderPay fires the confetti from here
        await renderPay(linkId);
        show("ok", "Payment confirmed! Your funds are being released automatically.");
      } else if (st === "CLAIMED") {
        celebrated = true;
        await renderPay(linkId);
        show("ok", "Payment completed successfully. The recipient has received the funds.");
        if (currentTab === "ledger") loadLedger();
        return;
      } else {
        /* Neither PAID nor CLAIMED inside the window: the callback is slow,
           not failed — the transaction itself already landed. Repaint and let
           the page's own status timer keep the card honest. */
        await renderPay(linkId);
        return;
      }
      /* PAID → CLAIMED. The keeper sweeps every minute, so watch for up to
         ~2 minutes; on completion stop, and if the window expires leave the
         pending message up — the keeper still owns the claim and the Release
         button remains as manual recovery. */
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const fresh = await V.getLink(linkId).catch(() => null);
        if (!fresh) continue; // transient read failure: keep watching
        if (statusOf(fresh) === "CLAIMED") {
          show("ok", "Payment completed successfully. The recipient has received the funds.");
          await renderPay(linkId);
          if (currentTab === "ledger") loadLedger();
          return;
        }
        if (i === 4) show("pending", "Your payment is confirmed. Automatic settlement is in progress.");
      }
      show("pending", "Your payment is confirmed. Automatic settlement is in progress.");
      await renderPay(linkId);
    })();
  } catch (err) {
    const msg = friendly(err);
    show("err", esc(msg));
    toast(msg);
  }
}

/* Manual recovery only: anyone can press this when the keeper is down — the
   payout still lands solely on the link's creator. The pay flow never calls
   this; settlement is the keeper's job, so the payer is never prompted twice. */
async function claimLink(linkId) {
  const line = $("#payStatus");
  const show = (cls, html) => { line.hidden = false; line.className = `tx-line ${cls}`; line.innerHTML = html; };

  if (!accountId) { toast("Connect a wallet first"); return connectWallet(); }
  show("pending", "signing the release…");
  try {
    const hash = await call("claim", { link_id: linkId }, { deposit: ONE_YOCTO, gas: GAS_CLAIM });
    show("ok", `released · <a class="mono" href="${CONFIG.explorer}/transactions/${hash}" target="_blank" rel="noopener">${truncate(hash, 12, 8)}</a>`);
    toast("Payment released to the payee");
    setTimeout(() => { renderPay(linkId); if (currentTab === "ledger") loadLedger(); }, 2500);
  } catch (err) {
    const msg = friendly(err);
    show("err", esc(msg));
    toast(msg);
  }
}

/* ──────────────────────────────────────── faucet + swap (Tidepool) ──
   Paylink's money token only exists on NEAR testnet, so a payer can
   arrive holding nothing — or holding something else. Two free, keyless
   exits through Tidepool, a community testnet sandbox of the NEAR 1Click
   API: the faucet drips test tokens, or a quote swaps whatever they hold
   into exactly enough USDC to cover this link. Fail-closed: if Tidepool
   is unreachable the rail shows the error and the normal pay flow is
   untouched. Test tokens only — never real funds. */

/* `id` is Tidepool's namespaced asset id — the form the 1Click quote API
   wants (originAsset / destinationAsset). `account` is the bare NEAR contract
   an ft_transfer_call must target: a receiver_id cannot contain ":", so
   passing `id` there fails to deserialize before the transaction is built.
   Verified against GET /v0/tokens: assetId → contractAddress. */
const SWAP_SOURCES = [
  { symbol: "wNEAR", id: "nep141:wnear.tidepool-sandbox.testnet", account: "wnear.tidepool-sandbox.testnet" },
  { symbol: "USDT", id: "nep141:usdt.tidepool-sandbox.testnet", account: "usdt.tidepool-sandbox.testnet" },
  { symbol: "ETH", id: "nep141:eth.tidepool-sandbox.testnet", account: "eth.tidepool-sandbox.testnet" },
];

let fundPollTimer = null;

/* The faucet block is one component in three homes — pay rail, Account card,
   phone sheet — so its markup and its handler are shared. `tag` keys each
   button to its own status line, so copies can coexist on one page, and the
   refreshers below repaint EVERY copy of a balance after a drip: no home is
   left showing the number the wallet held before the tokens landed. */
function faucetBlockHTML(tag) {
  const sym = esc(CONFIG.token.symbol);
  return `
        <div class="fund-block">
          <div class="fund-h">Get test tokens</div>
          <p class="fund-p">One faucet call drops 100 test ${sym}, 40 wNEAR and friends into your wallet — free, no sign-up.</p>
          <button class="btn btn-sm" type="button" data-faucet="${tag}"><span>Get test tokens</span></button>
          <div data-faucet-out="${tag}" class="tx-line" hidden></div>
        </div>`;
}

/* The sheet's body: balance row + the shared block + the Tidepool disclosure.
   Built in JS because the token symbol is chain config, not static copy. */
function sheetBodyHTML() {
  const sym = esc(CONFIG.token.symbol);
  return `
      <div class="row"><span>your ${sym} balance</span><code data-fund-bal>${accountId ? "…" : "connect a wallet"}</code></div>
      ${faucetBlockHTML("sheet")}
      <p class="fund-note">Tidepool — community testnet sandbox of NEAR's 1Click API. Test tokens only; never send real funds.</p>`;
}

/* Every balance readout the faucet rail shares, painted from one call. */
function refreshFundBal() {
  const els = $$("[data-fund-bal]");
  if (!els.length) return Promise.resolve();
  if (!accountId) { els.forEach((el) => { el.textContent = "connect a wallet"; }); return Promise.resolve(); }
  return V.ftBalanceOf(accountId)
    .then((b) => {
      const t = `${formatAmount(b)} ${CONFIG.token.symbol}`;
      els.forEach((el) => { el.textContent = t; });
    })
    .catch(() => { els.forEach((el) => { el.textContent = "—"; }); });
}

/* The Account panel's two numbers, re-read from chain. Called after render
   and again when the faucet lands. Skips itself (and its two RPC reads) when
   the panel was never built with a wallet, and re-checks after the await so
   a panel left mid-flight cannot paint into a node that is gone. */
async function paintAcctBalances() {
  const box = $("#accountBody");
  if (!box || !accountId || !box.querySelector("[data-acct-tok]")) return;
  const [tok, near] = await Promise.all([
    V.ftBalanceOf(accountId).catch(() => null),
    rpc("query", { request_type: "view_account", finality: "final", account_id: accountId })
      .then((r) => r?.amount).catch(() => null),
  ]);
  const tokEl = box.querySelector("[data-acct-tok]");
  if (tokEl) tokEl.textContent = tok == null ? "—" : `${formatAmount(tok)} ${CONFIG.token.symbol}`;
  const nearEl = box.querySelector("[data-acct-near]");
  if (nearEl) nearEl.textContent = near == null ? "—" : `${formatAmount(near, 24)} NEAR`;
}

/* One faucet call for every home: same request, same wording, same
   fail-closed behaviour — the error lands in the status line next to the
   button that was pressed, and the normal flow is never blocked. */
async function runFaucet(btn, out) {
  if (!accountId) { toast("Connect a wallet first"); return connectWallet(); }
  btn.disabled = true;
  out.hidden = false;
  out.className = "tx-line pending";
  out.textContent = "asking the faucet…";
  try {
    const res = await fetch(`${CONFIG.tidepool.origin}/v0/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, mode: "wallet" }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || `faucet returned ${res.status}`);
    const drips = (data.drips || []).map((d) => `${d.amount} ${d.symbol}`).join(" · ");
    out.className = "tx-line ok";
    out.innerHTML = `<div class="row"><span>sent</span><strong>${esc(drips)}</strong></div>`;
    refreshFundBal();
    await paintAcctBalances();
    toast("Test tokens sent to your wallet");
  } catch (err) {
    out.className = "tx-line err";
    out.textContent = err?.message || String(err);
  } finally {
    btn.disabled = false;
  }
}

/* Hook every faucet button under `root` to its own status line. The wired
   flag keeps a second pass (re-render, resize) from stacking listeners. */
function wireFaucet(root) {
  if (!root) return;
  $$("[data-faucet]", root).forEach((btn) => {
    if (btn.dataset.wired) return;
    const out = root.querySelector(`[data-faucet-out="${btn.dataset.faucet}"]`);
    if (!out) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => runFaucet(btn, out));
  });
}

function fundRail() {
  const sym = esc(CONFIG.token.symbol);
  const chips = SWAP_SOURCES.map((s, i) => `
            <button type="button" class="chip-btn fund-src${i === 0 ? " on" : ""}" data-i="${i}" aria-pressed="${i === 0}">${esc(s.symbol)}</button>`).join("");

  return `
    <details class="tech" id="fundRail">
      <summary>No test ${sym}? <span class="pill">free faucet &amp; swap</span></summary>
      <div class="tech-body">
        <div class="row"><span>your ${sym} balance</span><code data-fund-bal>${accountId ? "…" : "connect a wallet"}</code></div>
        ${faucetBlockHTML("rail")}
        <div class="fund-block">
          <div class="fund-h">or swap what you already hold <span class="pill">1Click sandbox</span></div>
          <div class="ai-row">${chips}</div>
          <button class="btn btn-sm" type="button" id="fundSwap"><span>Swap ${esc(SWAP_SOURCES[0].symbol)} and pay</span></button>
          <div id="fundSwapOut" class="tx-line" hidden></div>
        </div>
        <p class="fund-note">Tidepool — community testnet sandbox of NEAR's 1Click API. Test tokens only; never send real funds.</p>
      </div>
    </details>`;
}

function wireFundRail(link) {
  const rail = $("#fundRail");
  if (!rail) return;

  const swapBtn = $("#fundSwap");
  const swapOut = $("#fundSwapOut");
  let chosen = 0;

  refreshFundBal();
  wireFaucet(rail);

  $$(".fund-src", rail).forEach((btn) => btn.addEventListener("click", () => {
    $$(".fund-src", rail).forEach((b) => { b.setAttribute("aria-pressed", "false"); b.classList.remove("on"); });
    btn.setAttribute("aria-pressed", "true");
    btn.classList.add("on");
    chosen = Number(btn.dataset.i) || 0;
    swapBtn.querySelector("span").textContent = `Swap ${SWAP_SOURCES[chosen].symbol} and pay`;
    swapOut.hidden = true;
    /* A successful quote leaves the swap button disabled ("Send" became the
       next action) — but picking another source invalidates that quote, so
       the button must come back or the new chip is a dead end. */
    swapBtn.disabled = false;
  }));

  swapBtn.addEventListener("click", async () => {
    if (!accountId) { toast("Connect a wallet first"); return connectWallet(); }
    const src = SWAP_SOURCES[chosen];
    swapBtn.disabled = true;
    swapOut.hidden = false;
    swapOut.className = "tx-line pending";
    swapOut.textContent = "quoting…";
    try {
      const body = {
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: src.id,
        depositType: "INTENTS",
        destinationAsset: `nep141:${CONFIG.tokenId}`,  // 1Click namespaces asset ids; tokenId stays bare for contract calls
        amount: String(link.amount),
        refundTo: accountId,
        refundType: "INTENTS",
        recipient: accountId,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        dry: false,
      };
      const res = await fetch(`${CONFIG.tidepool.origin}/v0/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", /* any value selects Tidepool's lower fee tier — not a secret */ "X-API-Key": "paylink-testnet" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || `quote returned ${res.status}`);
      const q = data.quote;
      swapOut.className = "tx-line pending";
      swapOut.innerHTML = `
        <div class="row"><span>you send</span><strong>${esc(q.amountInFormatted)} ${esc(src.symbol)}</strong></div>
        <div class="row"><span>covers</span><strong>${esc(formatAmount(link.amount))} ${esc(CONFIG.token.symbol)}</strong></div>
        <div class="row"><span>estimate</span><span>~${esc(String(q.timeEstimate))}s</span></div>
        <button class="btn btn-sm" type="button" id="fundSend"><span>Send ${esc(q.amountInFormatted)} ${esc(src.symbol)}</span></button>
        <p class="fund-p">Your wallet signs one transfer to the intents verifier. Anything unfilled is refunded automatically.</p>
        <div id="fundPollOut" class="tx-line" hidden></div>`;
      $("#fundSend").addEventListener("click", async () => {
        const sendBtn = $("#fundSend");
        sendBtn.disabled = true;
        try {
          const hash = await call("ft_transfer_call", {
            receiver_id: CONFIG.tidepool.verifier,
            amount: q.amountIn,
            msg: q.depositAddress,
          }, { receiverId: src.account, gas: GAS_FT_CALL, deposit: ONE_YOCTO });
          /* Optional nudge so the status moves before the worker's own poll;
             if it fails the worker still picks the deposit up on its own. */
          fetch(`${CONFIG.tidepool.origin}/v0/deposit/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash: hash, depositAddress: q.depositAddress }),
          }).catch(() => {});
          pollSwap(q.depositAddress, src, swapBtn, refreshFundBal, link.link_id);
        } catch (err) {
          sendBtn.disabled = false;
          const o = $("#fundPollOut");
          if (o) { o.hidden = false; o.className = "tx-line err"; o.textContent = friendly(err); }
        }
      });
    } catch (err) {
      swapOut.className = "tx-line err";
      swapOut.textContent = err?.message || String(err);
      swapBtn.disabled = false; /* retry is just another quote */
    }
  });
}

/* Poll a live quote until it reaches a terminal state. The verdict comes
   from `status`, never from a swap hash — that is how 1Click clients are
   told to work, and it holds on testnet too. `linkId` is what turns the
   settle into a payment: the swap's proceeds go straight at the link from
   the same click, instead of leaving the payer to find the Pay button with
   the money already in their account. */
function pollSwap(depositAddress, src, swapBtn, refreshBal, linkId) {
  const out = $("#fundPollOut");
  if (!out) return;
  out.hidden = false;
  out.className = "tx-line pending";
  out.textContent = "submitted — waiting for the swap…";
  clearInterval(fundPollTimer);
  let ticks = 0;

  fundPollTimer = setInterval(async () => {
    ticks += 1;
    try {
      const res = await fetch(`${CONFIG.tidepool.origin}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const st = data.status;

      if (st === "SUCCESS") {
        clearInterval(fundPollTimer);
        fundPollTimer = null;
        const sd = data.swapDetails || {};
        out.className = "tx-line ok";
        out.innerHTML = `
          <div class="row"><span>swapped</span><strong>${esc(sd.amountInFormatted || "")} ${esc(src.symbol)} → ${esc(sd.amountOutFormatted || "")} ${esc(CONFIG.token.symbol)}</strong></div>
          <div class="row"><span>next</span><strong>paying this link with it&hellip;</strong></div>`;
        refreshBal();
        toast("Swap settled — paying now");
        /* One click, two moves: the swap settles and the payment follows from
           the same action. The wallet still signs each transaction — that is
           the part no free testnet build can chain — but the payer never has
           to go looking for the Pay button. */
        if (linkId) payLink(linkId);
        return;
      }
      if (st === "REFUNDED" || st === "FAILED") {
        clearInterval(fundPollTimer);
        fundPollTimer = null;
        const why = data.swapDetails?.refundReason;
        out.className = "tx-line err";
        out.textContent = st === "REFUNDED"
          ? `Nothing filled in time — your deposit was refunded${why ? ` (${String(why).toLowerCase()})` : ""}. Try again.`
          : "The swap failed and the refund did too. Nothing to recover here — try again or use the faucet.";
        swapBtn.disabled = false;
        return;
      }
      out.className = "tx-line pending";
      out.textContent = st === "PENDING_DEPOSIT"
        ? "waiting for your transfer to land…"
        : st === "PROCESSING"
          ? "settling the swap…"
          : `${String(st).toLowerCase()}…`;
      if (ticks >= 150) {
        clearInterval(fundPollTimer);
        fundPollTimer = null;
        out.className = "tx-line err";
        out.textContent = "Timed out waiting for the swap — your deposit is safe; reopen the link shortly and the status will catch up.";
        swapBtn.disabled = false;
      }
    } catch { /* transient network blip — keep polling */ }
  }, 4000);
}

/* ─────────────────────────────────────────────────────────── network ── */

/* Two of the three boot reads are contract config that cannot change during a
   session (the fee and the allowlisted token's metadata), and the free public
   RPC rate-limits quickly. Remember them for this tab so a reload costs one
   request instead of three.
   Payment state — get_link, get_links_by_creator — is never cached: a stale
   status there would show a link as unpaid after it was paid. */
const CFG_TTL_MS = 10 * 60_000;
const CFG_KEY = "paylink:cfg:v2";

function cfgRead() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(CFG_KEY) || "null");
    return raw && typeof raw.at === "number" && Date.now() - raw.at < CFG_TTL_MS
      ? raw
      : null;
  } catch { return null; } /* private mode: every load just re-reads */
}

function cfgWrite(patch) {
  try {
    const prev = (() => {
      try { return JSON.parse(sessionStorage.getItem(CFG_KEY) || "null") || {}; }
      catch { return {}; }
    })();
    sessionStorage.setItem(CFG_KEY, JSON.stringify({ ...prev, ...patch, at: Date.now() }));
  } catch { /* storage unavailable; the next load re-reads */ }
}

async function loadNetwork() {
  const cached = cfgRead();
  if (cached) {
    if (cached.symbol) CONFIG.token.symbol = cached.symbol;
    if (Number.isFinite(cached.feeBps)) CONFIG.feeBps = cached.feeBps;
  }

  /* Always live: this is the connection indicator, and a cached "ok" would be
     a lie the moment the RPC stops answering. The dot exists twice — header
     bar and phone sheet — so both get the same verdict. */
  const setDot = (ok) => $$(".js-netdot").forEach((d) => {
    d.classList.toggle("ok", ok);
    d.classList.toggle("err", !ok);
  });
  /* The footer used to print chain_id; there is nowhere to put it now, so the
     verdict goes to the dots alone. The call itself still has to happen —
     it is the health check. */
  try {
    await rpc("status", ["FINAL"]);
    setDot(true);
  } catch {
    setDot(false);
  }

  if (!cached || !cached.symbol) {
    try {
      const m = await V.ftMetadata(CONFIG.tokenId);
      if (m?.symbol) { CONFIG.token.symbol = m.symbol; cfgWrite({ symbol: m.symbol }); }
    } catch { /* metadata is advisory; the configured symbol stands */ }
  }
  if (!cached || !Number.isFinite(cached.feeBps)) {
    /* Keep the displayed fee honest: prefer the contract's own number over the
       copy in config.js. They are the same today; this makes a drift visible. */
    try {
      const bps = Number(await V.feeBps());
      if (Number.isFinite(bps) && bps >= 0 && bps < 10000) {
        CONFIG.feeBps = bps;
        cfgWrite({ feeBps: bps });
      }
    } catch { /* the configured rate stands */ }
  }
}

/* ───────────────────────────────────────────────────── activity feed ── */

/* There is no server to push a notification through, so the feed is derived:
   every timestamp on a link becomes an event, and "unread" is anything newer
   than the last time this panel was opened.

   A payee sees every link they created (get_links_by_creator). A payer sees
   only the links this browser paid for — the contract indexes by creator, not
   by payer — and those ids are written down locally at payment time. */

const PAID_KEY = "paylink:paidHere";
const SEEN_KEY = "paylink:feedSeen";

function paidHere() {
  try { return JSON.parse(localStorage.getItem(PAID_KEY) || "[]"); } catch { return []; }
}

function rememberPaid(id) {
  try {
    const list = paidHere();
    if (list.includes(id)) return;
    list.push(id);
    localStorage.setItem(PAID_KEY, JSON.stringify(list));
  } catch { /* private mode: the payer loses only their own local history */ }
}

let feedSeen = 0;
try { feedSeen = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { /* ignore */ }

function markFeedSeen() {
  feedSeen = Date.now();
  try { localStorage.setItem(SEEN_KEY, String(feedSeen)); } catch { /* ignore */ }
}

/* One link, expanded into the events it stands for. */
function eventsFor(link, isCreator) {
  const note = link.description || "Payment request";
  const amt = `${formatAmount(link.amount)} ${CONFIG.token.symbol}`;
  const out = [];

  if (link.paid_at) {
    out.push({
      t: Number(link.paid_at), tone: "good",
      title: isCreator ? "Payment received" : "You paid",
      meta: isCreator
        ? `${truncate(link.paid_by || "someone", 16, 4)} · ${note}`
        : note,
      amt,
    });
  }
  if (link.claimed_at) {
    out.push({
      t: Number(link.claimed_at), tone: "good",
      title: isCreator ? "Released to you" : "Payment released",
      meta: note, amt,
    });
  }
  if (statusOf(link) === "EXPIRED") {
    out.push({
      t: Number(link.expires_at) || Number(link.created_at) || 0, tone: "warn",
      title: "Expired without payment", meta: note, amt,
    });
  }
  if (isCreator && link.created_at) {
    out.push({ t: Number(link.created_at), tone: "", title: "Link created", meta: note, amt });
  }
  return out;
}

/* Everything this wallet can see, newest first. */
async function loadEvents() {
  const owned = (await V.byCreator(accountId).catch(() => [])) || [];
  const known = new Set(owned.map((l) => l.link_id));

  const rows = owned.map((l) => ({ l, isCreator: true }));
  for (const id of paidHere()) {
    if (known.has(id)) continue;
    const l = await V.getLink(id).catch(() => null);
    if (l) rows.push({ l, isCreator: false });
  }

  return rows
    .flatMap(({ l, isCreator }) => eventsFor(l, isCreator))
    .sort((a, b) => b.t - a.t);
}

const FEED_ICON = {
  good: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.4 6.4 11.3 12.5 4.8"/></svg>`,
  warn: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.8v3.5l2.2 1.4"/></svg>`,
  plain: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4a2.9 2.9 0 0 0 4.2.3l1.6-1.6a2.9 2.9 0 0 0-4.1-4.1l-.9.9"/><path d="M9.4 6.6a2.9 2.9 0 0 0-4.2-.3L3.6 7.9a2.9 2.9 0 0 0 4.1 4.1l.9-.9"/></svg>`,
};

function feedRow(e) {
  return `<div class="feed-item">
    <span class="feed-ico ${e.tone}">${FEED_ICON[e.tone] || FEED_ICON.plain}</span>
    <span class="feed-main">
      <span class="feed-t">${esc(e.title)}</span>
      <span class="feed-m">${esc(e.meta)} &middot; ${esc(timeAgo(e.t))}</span>
    </span>
    <span class="feed-amt">${esc(e.amt)}</span>
  </div>`;
}

function paintBadge(unread) {
  for (const id of ["#bellDot", "#tbDot"]) {
    const el = $(id);
    if (!el) continue;
    el.hidden = !unread;
    el.title = unread ? `${unread} unread` : "";
  }
}

/* Polls on its own cadence so the badge can light up without the panel being
   open. A failed read leaves the badge exactly as it was. */
let badgeBusy = false;
async function refreshBadge() {
  if (!accountId) return paintBadge(0);
  if (badgeBusy) return;
  badgeBusy = true;
  try {
    const events = await loadEvents();
    if (!feedSeen) markFeedSeen();   // first read: history is not "unread"
    paintBadge(events.filter((e) => e.t > feedSeen).length);
  } catch { /* transient RPC failure — keep the last verdict */ }
  finally { badgeBusy = false; }
}

async function renderAlerts() {
  const box = $("#alertsBody");
  if (!box) return;

  if (!accountId) {
    box.innerHTML = `<div class="feed-empty">Connect a wallet to see what happened on your links.
      <div><button class="btn btn-sm" type="button" data-wallet="connect"><span>Connect wallet</span></button></div></div>`;
    return;
  }

  box.innerHTML = `<div class="feed-empty">Reading the chain&hellip;</div>`;

  let events;
  try {
    events = await loadEvents();
  } catch (err) {
    box.innerHTML = `<div class="feed-empty">${esc(friendly(err))}
      <div><button class="btn btn-sm" type="button" data-alerts-retry><span>Try again</span></button></div></div>`;
    box.querySelector("[data-alerts-retry]")?.addEventListener("click", () => renderAlerts());
    return;
  }

  if (!events.length) {
    box.innerHTML = `<div class="feed-empty">Nothing yet. Create a link and its history lands here.</div>`;
    markFeedSeen();
    paintBadge(0);
    return;
  }

  box.innerHTML = events.map(feedRow).join("");
  /* Looking at the feed is what marks it read. */
  markFeedSeen();
  paintBadge(0);
}

async function renderAccount() {
  const box = $("#accountBody");
  if (!box) return;

  if (!accountId) {
    box.innerHTML = `<div class="acct-card">
      <span class="acct-k">wallet</span>
      <span class="acct-v">Nothing connected yet.</span>
      <div class="acct-actions">
        <button class="btn btn-sm" type="button" data-wallet="connect"><span>Connect wallet</span></button>
      </div>
    </div>`;
    return;
  }

  box.innerHTML = `
    <div class="acct-card">
      <span class="acct-k">connected account</span>
      <span class="acct-v mono">${esc(accountId)}</span>
      <div class="acct-actions">
        <button class="btn btn-sm ghost" type="button" data-acct-out><span>Disconnect</span></button>
      </div>
    </div>
    <div class="acct-card">
      <span class="acct-k">${esc(CONFIG.token.symbol)} balance</span>
      <span class="acct-v big" data-acct-tok>&hellip;</span>
    </div>
    <div class="acct-card">
      <span class="acct-k">NEAR for gas</span>
      <span class="acct-v big" data-acct-near>&hellip;</span>
    </div>
    <div class="acct-card">
      <span class="acct-k">no test ${esc(CONFIG.token.symbol)}?</span>
      <span class="acct-v">The free faucet drops 100 test ${esc(CONFIG.token.symbol)}, 40 wNEAR and friends into this wallet — no sign-up, no real funds.</span>
      <div class="acct-actions">
        <button class="btn btn-sm" type="button" data-faucet="acct"><span>Get test tokens</span></button>
      </div>
      <div data-faucet-out="acct" class="tx-line" hidden></div>
    </div>
    <div class="acct-card">
      <span class="acct-k">network</span>
      <span class="acct-v">NEAR testnet &middot; <span class="mono">${esc(CONFIG.contractId)}</span></span>
    </div>`;

  box.querySelector("[data-acct-out]")?.addEventListener("click", signOut);
  wireFaucet(box);

  await paintAcctBalances();
}

/* ─────────────────────────────────────────────────────────────── wire ── */

function wire() {
  /* debug: ?flat=1 disables reveal animation (used for screenshots) */
  if (new URLSearchParams(location.search).has("flat")) {
    document.documentElement.classList.add("flat");
  }

  $$('[role="tab"][data-tab]').forEach((b) =>
    b.addEventListener("click", () => go(b.dataset.tab)));
  $$("[data-tab-link]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); go(a.dataset.tabLink); }));

  $("#walletBtn").addEventListener("click", () => accountId ? signOut() : connectWallet());
  $("#walletDisconnect").addEventListener("click", signOut);

  /* The activity bell and the account button are the desktop entry points for
     the two panels the floating bar carries on a phone. */
  $("#bellBtn").addEventListener("click", () => go("alerts"));
  $("#acctBtn").addEventListener("click", () => go("account"));

  /* Faucet sheet: the phone's one-tap route to the same drip the pay rail
     and the Account card offer, opened from the chip beside the floating
     pill. The body is built once (it needs the token symbol) and wired with
     the shared handler; focus goes to Close on open and back to the chip on
     close, and the veil or Escape dismisses it. */
  const sheet = $("#faucetSheet");
  if (sheet) {
    $("#faucetBody").innerHTML = sheetBodyHTML();
    refreshFundBal();
    wireFaucet(sheet);
    const closeSheet = () => { sheet.hidden = true; $("#tbFaucet")?.focus(); };
    $("#tbFaucet").addEventListener("click", () => {
      sheet.hidden = false;
      refreshFundBal();
      $("#faucetClose")?.focus();
    });
    $("#faucetClose").addEventListener("click", closeSheet);
    /* a tap on the padding around the panel is a tap outside it */
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
  }

  $("#createForm").addEventListener("submit", handleCreate);
  $("#creatorInput").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
  $("#ledgerLoad").addEventListener("click", loadLedger);
  $("#exportCsv").addEventListener("click", exportCsv);

  document.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("[data-copy-text]");
    if (copyBtn) {
      const ok = await copyText(copyBtn.dataset.copyText);
      if (!ok) { toast("Could not copy"); return; }
      const text = copyBtn.dataset.copyLabel || "Copied";
      toast(text);
      /* Confirm on the button itself, not only in the toast — the button is
         what the user is looking at. */
      const label = copyBtn.querySelector("span");
      const before = label ? label.textContent : "";
      copyBtn.classList.add("done");
      if (label) label.textContent = text;
      setTimeout(() => {
        copyBtn.classList.remove("done");
        if (label && before) label.textContent = before;
      }, 1900);
      return;
    }

    const filterBtn = e.target.closest("[data-filter]");
    if (filterBtn) {
      const key = filterBtn.dataset.filter;
      if (!FILTERS[key]) return;
      ledgerFilter = key;
      $$("#ledgerFilters [data-filter]").forEach((b) =>
        b.classList.toggle("on", b.dataset.filter === key));
      renderLedger();
      return;
    }

    const goBtn = e.target.closest("[data-go]");
    if (goBtn) { go(goBtn.dataset.go); return; }

    const nativeBtn = e.target.closest("[data-native-share]");
    if (nativeBtn) {
      try {
        await navigator.share({
          title: "Paylink",
          text: nativeBtn.dataset.shareText,
          url: nativeBtn.dataset.nativeShare,
        });
      } catch { /* the user dismissed the share sheet */ }
      return;
    }

    const openBtn = e.target.closest("[data-open-pay]");
    if (openBtn) { openPay(openBtn.dataset.openPay); return; }

    const retryBtn = e.target.closest("[data-retry-pay]");
    if (retryBtn) { renderPay(retryBtn.dataset.retryPay); return; }

    const retryReady = e.target.closest("[data-retry-ready]");
    if (retryReady) { renderReady(retryReady.dataset.retryReady); return; }

    const payBtn = e.target.closest("[data-pay]");
    if (payBtn) { payLink(payBtn.dataset.pay); return; }

    const claimBtn = e.target.closest("[data-claim]");
    if (claimBtn) { claimLink(claimBtn.dataset.claim); return; }

    const focusBtn = e.target.closest("[data-focus]");
    if (focusBtn) {
      go("create");
      setTimeout(() => {
        const target = $(`#${focusBtn.dataset.focus}`) || $("#description");
        target?.focus();
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 260);
      return;
    }
    if (e.target.closest('[data-wallet="connect"]')) {
      /* Connected: the button reads "My links" and goes there — offering a
         connect flow over an open session is the bug this replaced. */
      if (accountId) go("ledger");
      else connectWallet();
    }
  });

  connector.on("wallet:signIn", refreshWallet);
  connector.on("wallet:signOut", refreshWallet);

  window.addEventListener("hashchange", route);
}

/* ───────────────────────────────────────────────────────────── AI wiring ── */

function setupAi() {
  if (!CONFIG.parseEndpoint) return;      // feature is simply absent, not broken
  $("#aiBlock").hidden = false;
  $("#aiFill").addEventListener("click", parseInvoice);

  const file = $("#aiFile");
  file.addEventListener("change", () => {
    const f = file.files[0];
    const label = $("#aiFileName");
    label.textContent = f ? f.name : "Attach a PDF or image";
    label.closest(".file-btn").classList.toggle("has-file", Boolean(f));
    aiNote("");
  });
}

/* ─────────────────────────────────────────────────────────────── boot ── */

wire();
initTheme();
setupAi();
loadNetwork();
route();
refreshWallet();
paintPayTo();

/* keep the pay page honest as the invoice moves or expires. Re-render only on a
   real change, so a pending wallet prompt, an open <details> or a 1Click quote
   is never thrown away by the timer. */
setInterval(async () => {
  if (currentTab !== "pay") return;
  const id = decodeURIComponent(location.hash.slice(1)).replace(/^pay\//, "");
  if (!id) return;
  const card = $("#payCard");
  const shown = card.dataset.status;
  if (!shown) return;
  try {
    const link = await V.getLink(id);
    if (link && statusOf(link) !== shown) {
      const st = statusOf(link);
      const landedNow = shown === "OPEN" && (st === "PAID" || st === "CLAIMED");
      /* The money landing while this page watches is the moment worth
         celebrating — and, for the payee, the notification that a payer
         has arrived. */
      if (landedNow) celebrated = true;
      await renderPay(id);
      if (landedNow && accountId && link.creator === accountId) toast("Payment received");
    }
  } catch { /* a transient RPC failure leaves the page as it is */ }
}, 30_000);

/* Same cadence for the activity badge, so it can light up while the feed is
   shut. Opening the feed re-reads on its own and does not wait for this. */
setInterval(refreshBadge, 30_000);
