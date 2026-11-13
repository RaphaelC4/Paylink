/* Paylink — the verifiable payment receipt (PDF).
 *
 * One-click download: the pay card renders a "Download PDF receipt" button
 * after a successful payment, and app.js turns the receipt model below into
 * a real PDF 1.4 byte stream — no dependencies, no build step, no network,
 * no print dialog. Everything here is pure text → bytes, so the node test
 * suite can assert on the exact output.
 *
 * Honesty rules that match the rest of the app:
 *   - the receipt only ever prints facts the caller already has (amounts,
 *     times, transaction hashes the wallet returned, ids from the chain);
 *     nothing is derived, rounded, priced or invented here;
 *   - a hash row exists only when a real hash exists — a cross-chain
 *     payout is verified from NEAR transaction evidence the Worker holds,
 *     and its receipt says exactly that instead of printing a hash it
 *     does not have;
 *   - the PDF is ASCII-only (WinAnsi Helvetica), so any byte in the file
 *     is a byte we wrote.
 */

/* The sentence every completed payment carries — on the card and in the PDF. */
export const RECEIPT_SENTENCE = "Payment delivered and verified on NEAR";

/* Line roles → Helvetica face, size and leading. One A4 page by design: a
   receipt is short, and a runaway input is clipped rather than paginated. */
const KINDS = {
  title: { font: "F2", size: 16, lead: 24 },
  sub: { font: "F2", size: 11, lead: 17 },
  head: { font: "F2", size: 10, lead: 17 },
  row: { font: "F1", size: 10, lead: 15 },
  body: { font: "F1", size: 10, lead: 15 },
  small: { font: "F1", size: 8.5, lead: 13 },
  rule: { font: "F1", size: 1, lead: 12 },
};

const TOP = 792; // first baseline, ~50pt below the A4 top edge (842)
const BOTTOM = 48; // nothing draws below this
const LEFT = 40;
const RIGHT = 555;
const MAX_CHARS = 96; // body width at 10pt Helvetica ≈ 515pt

/* Everything outside printable ASCII becomes "?": the file stays pure
   ASCII (byte === code unit), so offsets in the xref table are exact. */
function ascii(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    out += c >= 0x20 && c <= 0x7e ? ch : "?";
  }
  return out;
}

/* PDF literal-string escaping: backslash first, then the two parens. */
function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/* Greedy word wrap with a hard break for tokens longer than the line
   (a 64-char NEAR hash fits; a pathological 300-char value must not). */
function wrap(text, max) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines = [];
  let cur = "";
  for (const w of words) {
    let word = w;
    while (word.length > max) {
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= max) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* lines: [{ text, kind }] — kind defaults to "body"; "rule" draws a
   hairline instead of text. Returns the PDF's content stream. */
function contentStream(lines) {
  let y = TOP;
  let s = "";
  for (const line of lines) {
    const kind = KINDS[line && line.kind] ? line.kind : "body";
    const k = KINDS[kind];
    if (kind === "rule") {
      y -= k.lead;
      if (y < BOTTOM) break;
      s += `0.85 G ${LEFT} ${y.toFixed(2)} m ${RIGHT} ${y.toFixed(2)} l S\n`;
      continue;
    }
    const text = ascii(line && line.text != null ? line.text : "");
    for (const seg of wrap(text, kind === "title" ? 54 : MAX_CHARS)) {
      y -= k.lead;
      if (y < BOTTOM) break;
      s += `BT /${k.font} ${k.size} Tf 1 0 0 1 ${LEFT} ${y.toFixed(2)} Tm (${pdfEscape(seg)}) Tj ET\n`;
    }
  }
  return s;
}

/* The full PDF 1.4 file as bytes: six objects, one page, one content
   stream, a Helvetica pair, and an xref table whose offsets are computed
   from the exact bytes above it. */
export function buildReceiptPdf(lines) {
  const stream = contentStream(Array.isArray(lines) ? lines : []);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    null, // object 4 carries the stream
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    const n = i + 1;
    if (objs[i] === null) {
      out += `${n} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`;
    } else {
      out += `${n} 0 obj\n${objs[i]}\nendobj\n`;
    }
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0x7f;
  return bytes;
}

/* Safe on every platform: link ids are already [\w.-], anything else is
   folded to "_" so the download name can never escape its directory. */
export function receiptFilename(linkId) {
  const id = String(linkId || "payment").replace(/[^\w.-]/g, "_").slice(0, 64) || "payment";
  return `paylink-receipt-${id}.pdf`;
}
