/* Relayer-outage fallback tests — run with: node frontend/test/relayer-fallback.test.mjs
 *
 * L-08 P5: when the relayer fails, a direct-wallet creation happens ONLY
 * after (a) the chain confirmed the link was not created and (b) the
 * creator clicked "Create directly". These are behavioural tests: the call,
 * callViaRelayer, friendly and create-flow blocks are sliced out of app.js
 * and executed against a scripted relayer, a scripted chain read and a
 * scripted wallet, so every scenario asserts what actually happened —
 * exact fetch counts, exact wallet-transaction counts, exact link ids.
 *
 * The mandatory duplicate guarantee leans on the contract's own rule
 * (`link id already used`, asserted at the bottom): the fallback reuses the
 * ORIGINAL link id, so a relayer broadcast that lands late can only make
 * the direct transaction revert — never a second payable invoice.
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const relayerSrc = readFileSync(new URL("../../workers/relayer/src/index.js", import.meta.url), "utf8");
const keeperSrc = readFileSync(new URL("../../workers/keeper/src/index.js", import.meta.url), "utf8");
const contractSrc = readFileSync(new URL("../../contracts/paylink-contract/src/lib.rs", import.meta.url), "utf8");

/* ── slice the flow out of app.js (marker-bounded, no brace guessing) ── */

const callStart = src.indexOf("function failureReason(f)");
const callEnd = src.indexOf("const TABS = [");
ok(callStart >= 0, "failureReason/call block start marker found");
ok(callEnd > callStart, "call block end marker found after start");
const callBlock = src.slice(callStart, callEnd);
ok(callBlock.includes("async function call(methodName"), "block contains call()");
ok(callBlock.includes("async function callViaRelayer(methodName"), "block contains callViaRelayer()");
ok(callBlock.includes("e.relayerStatus = r.status"),
  "a relayer reply's status rides along on the error (classification input)");

const createStart = src.indexOf("function newLinkId()");
const createEnd = src.indexOf("const SHARE_ICONS = {");
ok(createStart >= 0, "create block start marker found");
ok(createEnd > createStart, "create block end marker found after start");
const createBlock = src.slice(createStart, createEnd);
for (const fn of ["async function handleCreate(", "async function performCreate(ctx)",
  "async function resolveRelayerFailure(err, ctx)", "function relayerEligibility(err)",
  "async function checkCreated(linkId)", "function askDirectCreate()",
  "async function resumeUnconfirmed(ctx)", "function retryUnknownCreate()",
  "async function finishCreated(hash, ctx)"]) {
  ok(createBlock.includes(fn), `create block contains ${fn.replace(/\(.*$/, "")}()`);
}

const friendlyStart = src.indexOf("function friendly(err) {");
const friendlyEnd = src.indexOf('const THEME_KEY = "paylink:theme";');
ok(friendlyStart >= 0 && friendlyEnd > friendlyStart, "friendly() block markers found");
const friendlyBlock = src.slice(friendlyStart, friendlyEnd);

/* ── harness: a fake DOM, relayer, chain and wallet ── */

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function makeApp(opts = {}) {
  const {
    relayer = reply({ ok: true, hash: "RelayHash111" }),
    endpoint = "https://relayer.test/submit",
    delegateCapable = true,
  } = opts;

  const s = {
    log: [],
    fetchCalls: [],
    delegateSigns: [],
    walletTxs: [],
    chainReads: [],
    toasts: [],
    openReady: [],
    connectCalls: [],
    resets: 0,
    sheetLookups: 0,
    chainFn: () => null,
    directError: null,
  };

  const makeEl = (id) => ({
    id, hidden: true, className: "", textContent: "", innerHTML: "", disabled: false,
    dataset: {}, children: [], listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); },
    dispatch(ev, arg) { (this.listeners[ev] || []).slice().forEach((f) => f(arg)); },
    focus() {},
    querySelector() { if (!this._span) this._span = makeEl(`${id}-span`); return this._span; },
    appendChild(c) { this.children.push(c); },
    closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  });

  const els = {
    "#createResult": makeEl("createResult"),
    "#createBtn": makeEl("createBtn"),
    "#fallbackSheet": makeEl("fallbackSheet"),
    "#fallbackDirect": makeEl("fallbackDirect"),
    "#fallbackCancel": makeEl("fallbackCancel"),
    "#payToField": null, "#payToAddr": null, "#payToBadge": null,
    "#toast": makeEl("toast"),
  };

  const $ = (sel) => {
    if (sel === "#fallbackSheet") { s.sheetLookups++; s.log.push("sheet"); }
    return Object.prototype.hasOwnProperty.call(els, sel) ? els[sel] : null;
  };

  const documentStub = {
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); },
    createElement: (tag) => makeEl(tag),
  };

  const wallet = {
    ...(delegateCapable
      ? { signDelegateActions: async (a) => { s.delegateSigns.push(a); return { signedDelegateActions: [{ stub: true }] }; } }
      : {}),
    signAndSendTransaction: async (tx) => {
      s.walletTxs.push(tx);
      if (s.directError) throw new Error(s.directError);
      return { transaction: { hash: "DirectHash001" } };
    },
  };

  const CONFIG = {
    relayer: { endpoint },
    explorer: "https://explorer.test",
    contractId: "paylink-v2.testnet",
    tokenId: "usdc.test",
    token: { symbol: "USDC" },
  };

  const V = {
    getLink: async (id) => {
      s.chainReads.push(id);
      s.log.push("chain");
      const r = s.chainFn();
      if (r instanceof Error) throw r;
      return r;
    },
  };

  const deps = {
    fetch: async (url, init) => {
      s.fetchCalls.push({ url, body: init ? JSON.parse(init.body) : null });
      if (relayer instanceof Error) throw relayer;
      if (typeof relayer === "function") return relayer(s.fetchCalls.length);
      return relayer;
    },
    CONFIG,
    connector: { wallet: async () => wallet },
    accountId: "alice.testnet",
    V,
    $,
    document: documentStub,
    toast: (m) => { s.toasts.push(m); },
    truncate: (h) => String(h).slice(0, 12),
    toBaseUnits: () => "1000000",
    connectWallet: () => { s.connectCalls.push(1); },
    openReady: async (id) => { s.openReady.push(id); },
    MAX_DESCRIPTION_BYTES: 280,
    CREATE_STAKE: "10000000000000000000000",
    GAS_DEFAULT: "50000000000000",
  };

  const body = `${callBlock}\n${createBlock}\n${friendlyBlock}
return { handleCreate, performCreate, resolveRelayerFailure, relayerEligibility,
         checkCreated, askDirectCreate, retryUnknownCreate, call, callViaRelayer };`;

  const api = new Function(...Object.keys(deps), body)(...Object.values(deps));

  const form = {
    description: { value: "Coffee" },
    amount: { value: "5" },
    expires: { value: "24" },
    reset() { s.resets++; },
  };
  const evt = { preventDefault() {}, currentTarget: form };

  return {
    s, els, api, form, evt, doc: documentStub,
    run: () => api.handleCreate(evt),
    clickDirect: () => els["#fallbackDirect"].dispatch("click"),
    clickCancel: () => els["#fallbackCancel"].dispatch("click"),
    setChain: (fn) => { s.chainFn = fn; },
    setDirectError: (m) => { s.directError = m; },
    sheet: els["#fallbackSheet"],
    line: els["#createResult"],
    btn: els["#createBtn"],
    label: els["#createBtn"].querySelector("span"),
    delegatedLinkId: () => s.delegateSigns[0]?.delegateActions?.[0]?.actions?.[0]?.params?.args?.link_id,
    directLinkId: () => s.walletTxs[0]?.actions?.[0]?.params?.args?.link_id,
  };
}

const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
const promptOpen = (h) => h.s.sheetLookups > 0 && h.sheet.hidden === false;

/* ══════════ 1. normal relayer success: no fallback prompt ══════════ */

{
  const h = makeApp();
  const p = h.run();
  await flush();
  await p;
  ok(h.s.sheetLookups === 0, "1. success: the consent dialog is never opened");
  ok(h.s.walletTxs.length === 0, "1. success: no direct wallet transaction");
  ok(h.s.fetchCalls.length === 1, "1. success: exactly one relayer POST");
  ok(h.s.delegateSigns.length === 1, "1. success: exactly one delegate signature");
  ok(h.s.chainReads.length === 0, "1. success: no chain check needed");
  ok(h.line.className === "tx-line ok" && h.line.innerHTML.includes("RelayHash111"),
    "1. success: line shows the relayer's real tx hash");
  ok(h.s.openReady.length === 1, "1. success: ready page opened");
  ok(h.s.resets === 1 && h.btn.disabled === false && h.label.textContent === "Create link",
    "1. success: form reset and controls restored");
}

/* ══════════ 14. relayer-first behaviour unchanged ══════════ */

{
  /* wallet cannot sign delegates → the pre-existing direct corner case */
  const h = makeApp({ delegateCapable: false });
  const p = h.run();
  await flush();
  await p;
  ok(h.s.fetchCalls.length === 0, "14. no-delegate wallet: relayer never POSTed (unchanged)");
  ok(h.s.walletTxs.length === 1 && h.s.sheetLookups === 0,
    "14. no-delegate wallet: one direct tx, no consent dialog (unchanged)");

  /* no relayer endpoint configured → direct, exactly as before */
  const h2 = makeApp({ endpoint: "" });
  const p2 = h2.run();
  await flush();
  await p2;
  ok(h2.s.fetchCalls.length === 0 && h2.s.walletTxs.length === 1 && h2.s.sheetLookups === 0,
    "14. empty endpoint: one direct tx, no relayer call, no dialog (unchanged)");
}

/* ══════════ relayerEligibility: the classification rules ══════════ */

{
  const E = makeApp().api.relayerEligibility;
  for (const status of [400, 401, 403, 404, 413, 422]) {
    ok(E({ relayerStatus: status }) === "declined", `eligibility: HTTP ${status} → declined (no fallback)`);
  }
  ok(E({ relayerStatus: 429 }) === "declined", "eligibility: 429 → declined (rate limits are never bypassed)");
  ok(E({ relayerStatus: 503, relayerMessage: "relayer balance too low — fund the relayer account" }) === "declined",
    "eligibility: insufficient-balance 503 → declined (P5 §3)");
  /* Pin the relayer's actual message: the frontend recognises it by text
     (the Worker exposes no reason codes), so a rewording on the relayer
     side must fail HERE and force the regex update, not silently degrade. */
  ok(relayerSrc.includes("relayer balance too low — fund the relayer account"),
    "the relayer's balance_low message is pinned — rewording forces a frontend update");
  for (const [status, msg] of [[500, "internal"], [502, "broadcast failed"], [503, "could not reach the relayer's access key — try again"], [502, null]]) {
    ok(E({ relayerStatus: status, relayerMessage: msg }) === "unconfirmed",
      `eligibility: ${status} ${msg ? `"${msg.slice(0, 24)}…"` : "(no body)"} → unconfirmed (chain must decide)`);
  }
  ok(E({ relayerStatus: 0 }) === "unconfirmed", "eligibility: no reply at all → unconfirmed");
  ok(E(new Error("Failed to fetch")) === "unconfirmed", "eligibility: plain network error → unconfirmed");
}

/* ══════════ 2+4+8. eligible outage: establish on chain, then consent ══════════ */

{
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  h.setChain(() => null); // the chain says: no such link
  const p = h.run();
  await flush();
  ok(h.s.chainReads.length === 1, "8. network failure: the chain was checked first");
  ok(h.s.log.indexOf("chain") < h.s.log.indexOf("sheet"),
    "8. the chain check happens BEFORE the consent dialog is offered");
  ok(promptOpen(h), "2+8. confirmed-absent outage: the consent dialog appears");
  ok(h.s.walletTxs.length === 0,
    "2. nothing is signed automatically while the dialog waits (no auto-switch)");
  ok(h.btn.disabled === true, "the create button waits for the outcome");

  h.clickDirect();
  await p;
  ok(h.s.walletTxs.length === 1, "4. accepted: exactly one direct wallet transaction");
  const tx = h.s.walletTxs[0];
  ok(tx.actions[0].params.methodName === "create_link", "4. it is the create_link call");
  ok(tx.actions[0].params.deposit === "10000000000000000000000",
    "4. it carries the exact 0.01 NEAR stake (economics unchanged)");
  ok(tx.receiverId === "paylink-v2.testnet" && tx.signerId === "alice.testnet",
    "4. signed by the creator, sent to the contract");
  ok(h.directLinkId() === h.delegatedLinkId(),
    "4. the ORIGINAL link id and parameters are reused — never a second id");
  ok(h.line.className === "tx-line ok" && h.line.innerHTML.includes("DirectHash001"),
    "4. success line shows the direct tx hash");
  ok(h.s.openReady.length === 1 && h.s.resets === 1, "4. ready page opened, form reset");
  ok(h.sheet.hidden === true && (h.sheet.listeners.click || []).length === 0
    && (h.doc.listeners.keydown || []).length === 0,
    "the dialog cleaned up its veil/Escape listeners behind it");
}

/* ══════════ 3. user cancels: no direct transaction ══════════ */

{
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  h.setChain(() => null);
  const p = h.run();
  await flush();
  ok(promptOpen(h), "3. dialog appears for a confirmed-absent outage");
  h.clickCancel();
  await p;
  ok(h.s.walletTxs.length === 0, "3. cancel: NO direct transaction is submitted");
  ok(h.s.openReady.length === 0 && h.s.resets === 0, "3. cancel: no ready page, form untouched");
  ok(h.line.textContent.includes("Creation cancelled") && h.line.className === "tx-line",
    "3. cancel: the line says exactly what happened");
  ok(h.s.toasts.includes("Creation cancelled"), "3. cancel: toast matches");
  ok(h.btn.disabled === false && h.label.textContent === "Create link", "3. cancel: controls restored");
}

/* ══════════ 5. 4xx: no fallback ══════════ */

for (const status of [400, 401, 403, 422]) {
  const h = makeApp({ relayer: reply({ error: "signature does not verify under the sender's public key" }, status) });
  const p = h.run();
  await flush();
  await p;
  ok(h.s.sheetLookups === 0, `5. HTTP ${status}: no consent dialog`);
  ok(h.s.walletTxs.length === 0 && h.s.chainReads.length === 0,
    `5. HTTP ${status}: no direct tx and no chain check (declined outright)`);
  ok(h.line.className === "tx-line err"
    && h.line.textContent.includes("signature does not verify"),
    `5. HTTP ${status}: the relayer's own message is shown honestly`);
}

/* ══════════ 6. 429: no fallback, never bypassed ══════════ */

{
  const h = makeApp({ relayer: reply({ error: "rate limit: try again later" }, 429) });
  const p = h.run();
  await flush();
  await p;
  ok(h.s.sheetLookups === 0 && h.s.walletTxs.length === 0 && h.s.chainReads.length === 0,
    "6. 429: no dialog, no direct tx, no chain check");
  ok(h.line.className === "tx-line err"
    && h.line.textContent.includes("The network is busy"),
    "6. 429: friendly() maps it to the back-off message, not a fallback");
}

/* ══════════ 7. 5xx: fallback only after the chain establishes safety ══════════ */

{
  /* 503 the relayer never processed → chain absent → prompt, then cancel */
  const h = makeApp({ relayer: reply({ error: "could not reach the relayer's access key — try again" }, 503) });
  h.setChain(() => null);
  const p = h.run();
  await flush();
  ok(h.s.chainReads.length === 1 && promptOpen(h),
    "7. 503 with the chain confirming absence: dialog appears");
  ok(h.s.walletTxs.length === 0, "7. 503: no transaction before consent");
  h.clickCancel();
  await p;
  ok(h.s.walletTxs.length === 0, "7. 503 + cancel: still no transaction");

  /* the SAME 5xx but the link IS on chain (the relayer actually succeeded) */
  const h2 = makeApp({ relayer: reply({ error: "internal" }, 500) });
  h2.setChain(() => ({ creator: "alice.testnet", status: "Open" }));
  const p2 = h2.run();
  await flush();
  await p2;
  ok(h2.s.sheetLookups === 0, "7. 5xx but the link exists: NO dialog (no duplicate offered)");
  ok(h2.s.walletTxs.length === 0, "7. 5xx but the link exists: no direct tx");
  ok(h2.line.className === "tx-line ok" && h2.line.innerHTML.includes("created · your link is ready"),
    "7. it reports the creation the chain confirmed");
  ok(!h2.line.innerHTML.includes("transactions/"), "7. no tx hash is fabricated for a lost reply");
  ok(h2.s.openReady.length === 1, "7. the ready page opens for the real link");
}

/* ══════════ 10. existing link id found on-chain: no duplicate creation ══════════ */

{
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  h.setChain(() => ({ creator: "alice.testnet", status: "Open", amount: "1000000" }));
  const p = h.run();
  await flush();
  await p;
  ok(h.s.sheetLookups === 0, "10. link already on chain: the dialog never appears");
  ok(h.s.walletTxs.length === 0, "10. link already on chain: NO direct duplicate creation");
  ok(h.line.className === "tx-line ok" && h.s.openReady.length === 1,
    "10. the existing link is shown as created (the relayer's reply was simply lost)");
}

/* ══════════ 9. timeout/unknown: pending state, re-check, never a duplicate ══════════ */

{
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  let reads = 0;
  h.setChain(() => { reads++; return new Error("chain unreadable"); });
  const p = h.run();
  await flush();
  ok(h.s.sheetLookups === 0 && h.line.innerHTML.includes("data-recheck-create"),
    "9. unreadable chain: pending state with 'Check again', no dialog");
  ok(h.line.innerHTML.includes("could not confirm"), "9. the pending message is explicit");
  ok(h.s.walletTxs.length === 0 && h.btn.disabled === true,
    "9. no transaction, create button held while the outcome is unresolved");

  await h.api.retryUnknownCreate();
  await flush();
  ok(h.s.chainReads.length === 2 && h.s.fetchCalls.length === 1,
    "9. 'Check again' re-reads the chain and does NOT re-POST to the relayer");
  ok(h.s.walletTxs.length === 0 && h.line.innerHTML.includes("data-recheck-create"),
    "9. still unresolved: still no transaction");

  h.setChain(() => null); // chain readable again: link absent
  const rp = h.api.retryUnknownCreate(); // opens the dialog — do NOT await (it waits for the click)
  await flush();
  ok(promptOpen(h), "9. once the chain answers, the consent dialog appears");
  ok(h.s.walletTxs.length === 0, "9. still nothing signed without consent");
  h.clickCancel();
  await rp;
  ok(h.s.walletTxs.length === 0 && h.btn.disabled === false,
    "9. the whole episode ends with zero transactions");
}

/* ══════════ 11. duplicate link id rejected safely ══════════ */

{
  /* the relayer's broadcast lands AFTER the post-consent re-check: the
     contract's duplicate refusal is the backstop, and the re-read after the
     revert reports the true outcome */
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  let reads = 0;
  h.setChain(() => (reads++ < 2 ? null : { creator: "alice.testnet", status: "Open" }));
  const p = h.run();
  await flush();
  ok(promptOpen(h), "11. dialog appears while the chain says absent");
  h.setDirectError("Smart contract panicked: link id already used");
  h.clickDirect();
  await p;
  ok(h.s.walletTxs.length === 1, "11. the direct attempt was made once");
  ok(h.s.chainReads.length === 3, "11. chain reads: before dialog, after consent, after the revert");
  ok(h.line.className === "tx-line ok" && h.s.openReady.length === 1,
    "11. the contract's refusal resolves to the TRUE outcome: the link exists");
  ok(h.s.toasts.includes("Link created") && !h.line.textContent.includes("already used"),
    "11. no false failure is shown when the relayer's tx actually landed");

  /* the id belongs to somebody else entirely (beyond-astronomical collision) */
  const h2 = makeApp({ relayer: new TypeError("Failed to fetch") });
  let reads2 = 0;
  h2.setChain(() => (reads2++ < 2 ? null : { creator: "bob.testnet", status: "Open" }));
  const p2 = h2.run();
  await flush();
  h2.setDirectError("Smart contract panicked: link id already used");
  h2.clickDirect();
  await p2;
  ok(h2.line.className === "tx-line err" && h2.line.textContent.includes("link id already used"),
    "11. an occupied id fails honestly instead of claiming success");
  ok(h2.s.openReady.length === 0 && !h2.line.innerHTML.includes("created ·"),
    "11. no success message for someone else's link");
}

/* ══════════ 11b. the race caught by the post-consent re-check: ZERO txs ══════════ */

{
  /* the relayer's broadcast lands WHILE the dialog is open — the re-check
     right after consent sees it, so no wallet transaction is ever signed */
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  let reads = 0;
  h.setChain(() => (reads++ === 0 ? null : { creator: "alice.testnet", status: "Open" }));
  const p = h.run();
  await flush();
  ok(promptOpen(h), "11b. dialog appears while the chain says absent");
  h.clickDirect();
  await p;
  ok(h.s.walletTxs.length === 0, "11b. the race is caught before signing: ZERO wallet transactions");
  ok(h.s.chainReads.length === 2, "11b. chain read before the dialog and again after consent");
  ok(h.line.className === "tx-line ok" && h.s.openReady.length === 1,
    "11b. the already-created link is reported as success");
  ok(h.s.toasts.includes("Link created"), "11b. the user sees the truth, not a revert");
}

/* ══════════ 12. direct transaction failure: accurate error, no false success ══════════ */

{
  const h = makeApp({ relayer: new TypeError("Failed to fetch") });
  h.setChain(() => null);
  const p = h.run();
  await flush();
  h.setDirectError("You rejected the request in your wallet");
  h.clickDirect();
  await p;
  ok(h.line.className === "tx-line err", "12. failure renders as an error line");
  ok(h.line.textContent.includes("You rejected the request in your wallet. Nothing was sent."),
    "12. friendly() gives the accurate, actionable message");
  ok(!h.line.innerHTML.includes("created") && h.s.openReady.length === 0 && h.s.resets === 0,
    "12. no false success, no ready page, form untouched");
  ok(h.btn.disabled === false && h.label.textContent === "Create link", "12. controls restored");
}

/* ══════════ source guards: wording, wiring, and what must NOT change ══════════ */

ok(html.includes("Paylink's relayer is temporarily unavailable. You can still create this payment link directly with your NEAR wallet. Your wallet will pay the required 0.01 NEAR stake and transaction gas. Would you like to continue?"),
  "the dialog uses the specified wording, costs and all");
ok(html.includes("<span>Create directly</span>") && html.includes("<span>Cancel</span>"),
  "the dialog offers exactly 'Create directly' and 'Cancel'");
ok(src.includes('e.target.closest("[data-recheck-create]")') && src.includes("retryUnknownCreate();"),
  "'Check again' is wired through the delegated click handler");
ok(createBlock.includes("await V.getLink(linkId)"),
  "the ambiguous-outcome check goes through the existing view path (finality: final)");
ok(!createBlock.includes("performCreate(ctx)") || createBlock.includes("resumeUnconfirmed(ctx)"),
  "'Check again' resumes via resumeUnconfirmed, never via a fresh create");

ok(contractSrc.includes('require!(self.links.get(&link_id).is_none(), "link id already used")'),
  "the contract still refuses duplicate link ids — the fallback's structural guarantee");
ok(contractSrc.includes("fn create_link_rejects_a_duplicate_id()"),
  "and that rule is covered by a contract test");

ok(relayerSrc.includes('if (method === "broadcast_tx_commit")')
  && relayerSrc.includes("return rpcOnce(urls[0], method, params, timeoutMs);"),
  "relayer broadcast policy untouched: primary only, once, no failover (P5 §6)");
ok(keeperSrc.includes('if (method === "broadcast_tx_commit")')
  && keeperSrc.includes("return rpcOnce(urls[0], method, params, timeoutMs);"),
  "keeper broadcast policy untouched: primary only, once (P5 §6)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
