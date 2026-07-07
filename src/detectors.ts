/**
 * Secret detectors that run on OCR'd text lines.
 *
 * This is a faithful TypeScript port of the Python LeakShot detector engine
 * (leakshot/detectors.py). It takes text that came out of OCR (often garbled)
 * and finds secrets in it. Every finding is tagged with a precision tier so the
 * UI can show how much to trust it.
 *
 * Design notes:
 * - OCR mangles characters. We run each detector on three views of a line: the
 *   raw line, a space-collapsed version, and a confusion-denoised version. We
 *   apply an OCR confusion map (0<->O, 1<->l<->I, 5<->S, 8<->B, Z<->7...) as
 *   equivalence classes, but ONLY where the token's charset allows it.
 * - Every match records the character span in the (normalized) line so the
 *   pipeline can map it back to a pixel box for redaction.
 *
 * This module is PURE (no DOM) so it can be unit-tested in Node with vitest.
 */

export const TIER_HIGH = "high";
export const TIER_MEDIUM = "medium";
export const TIER_FUZZY = "fuzzy";

export type Tier = typeof TIER_HIGH | typeof TIER_MEDIUM | typeof TIER_FUZZY;

export interface Finding {
  detector: string; // human name of the detector that fired
  secretType: string; // canonical type, e.g. "aws_access_key"
  tier: Tier; // TIER_HIGH / TIER_MEDIUM / TIER_FUZZY
  matchedText: string; // the exact substring we consider the secret
  start: number; // char offset into the line we scanned
  end: number; // char offset (exclusive)
  lineIndex: number; // set by the pipeline (-1 until then)
  denoised: boolean; // true if found only after de-noising
  notes: string;
}

function makeFinding(f: Partial<Finding> & {
  detector: string;
  secretType: string;
  tier: Tier;
  matchedText: string;
  start: number;
  end: number;
}): Finding {
  return {
    lineIndex: -1,
    denoised: false,
    notes: "",
    ...f,
  };
}

// ---------------------------------------------------------------------------
// OCR de-noising
// ---------------------------------------------------------------------------

// Characters Apple Vision commonly swaps. Mapping is "seen char" -> string of
// "could really be" chars. Used only when a token charset restricts choices.
const _CONFUSION: Record<string, string> = {
  "0": "O",
  O: "0",
  "1": "lI",
  l: "1I",
  I: "1l",
  "5": "S",
  S: "5",
  "8": "B",
  B: "8",
  "2": "Z",
  Z: "2",
  "6": "G",
  G: "6",
  "9": "g",
  q: "9",
};

/**
 * Remove single spaces that OCR sometimes inserts inside a long token.
 * We only collapse a space when it sits between two token-ish characters
 * (alphanumeric, or the symbols keys/tokens use). This turns
 * 'AKIA IOSF ODNN' back into 'AKIAIOSFODNN' without gluing real words.
 */
function _collapseTokenSpaces(text: string): string {
  return text.replace(
    /(?<=[A-Za-z0-9_\-+/=.])[ ]{1,2}(?=[A-Za-z0-9_\-+/=.])/g,
    "",
  );
}

/**
 * Generate variants of token by fixing OCR-confused chars.
 * For each position, if the seen character is NOT in `allowed` but one of its
 * confusion partners IS, we substitute. This is the common case (single
 * deterministic fix). `allowed` is the charset the format permits.
 */
function _confusionVariants(
  token: string,
  allowed: string,
  maxVariants = 32,
): string[] {
  const allowedSet = new Set(allowed);
  const fixed: string[] = [];
  let changed = false;
  for (const ch of token) {
    if (allowedSet.has(ch)) {
      fixed.push(ch);
      continue;
    }
    let repl: string | null = null;
    for (const cand of _CONFUSION[ch] ?? "") {
      if (allowedSet.has(cand)) {
        repl = cand;
        break;
      }
    }
    if (repl !== null) {
      fixed.push(repl);
      changed = true;
    } else {
      fixed.push(ch); // leave it; regex will just fail to match
    }
  }
  const variants: string[] = [];
  if (changed) variants.push(fixed.join(""));
  return variants.slice(0, maxVariants);
}

// ---------------------------------------------------------------------------
// False-positive suppression
// ---------------------------------------------------------------------------

// Known example / placeholder values that vendors publish. Case-insensitive
// substring / exact match against the candidate.
const _ALLOWLIST = new Set([
  "akiaiosfodnn7example",
  "wjalrxutnfemi/k7mdeng/bpxrficyexamplekey",
  "your_api_key_here",
  "your-api-key-here",
  "changeme",
  "xxxxxxxx",
  "example",
  "sk_test_example",
  "insert_key_here",
  "placeholder",
]);

const _ALLOWLIST_SUBSTR = [
  "example",
  "xxxxxxxx",
  "your_api_key",
  "your-api-key",
  "placeholder",
  "insert_key",
  "changeme",
  "<token>",
  "<your",
  "redacted",
];

function _isAllowlisted(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (_ALLOWLIST.has(v)) return true;
  for (const sub of _ALLOWLIST_SUBSTR) {
    if (v.includes(sub)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validators for the high-precision detectors
// ---------------------------------------------------------------------------

/**
 * Standard Luhn checksum. `digits` must be only digits.
 * Degenerate strings like all-zeros or a single repeated digit pass Luhn
 * trivially but are never real cards, so we require at least two distinct
 * nonzero digits before accepting the candidate.
 */
function _luhnOk(digits: string): boolean {
  if (!(digits.length >= 13 && digits.length <= 19)) return false;
  const nonzero = new Set(digits);
  nonzero.delete("0");
  if (nonzero.size < 2) return false;
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(i) - 48;
    if (i % 2 === parity) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

// ---- base64url helpers (browser + Node safe, no Buffer dependency) ----

function _b64urlToBytes(seg: string): Uint8Array | null {
  // Pad to a multiple of 4, translate url-safe alphabet to standard.
  let s = seg.replace(/-/g, "+").replace(/_/g, "/");
  s = s + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    // atob is available in browsers and modern Node (>=16 global).
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function _bytesToUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decode one base64url JWT segment to a JSON object, returning it or null. */
function _decodeJsonSeg(seg: string): Record<string, unknown> | null {
  const bytes = _b64urlToBytes(seg);
  if (bytes === null) return null;
  const text = _bytesToUtf8(bytes);
  if (text === null) return null;
  try {
    const obj = JSON.parse(text);
    return obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// base64url alternates OCR may have produced for a given confusable glyph.
// Both members are valid base64url characters, so charset cannot disambiguate;
// we decode and check the result instead.
const _B64_AMBIG: Record<string, string[]> = {
  "0": ["O", "o"],
  O: ["0", "o"],
  o: ["0", "O"],
  "1": ["l", "I"],
  l: ["1", "I"],
  I: ["1", "l"],
  "5": ["S", "s"],
  S: ["5", "s"],
  s: ["5", "S"],
  "8": ["B", "b"],
  B: ["8", "b"],
  "2": ["Z", "z"],
  Z: ["2", "z"],
  "9": ["g", "q"],
  g: ["9"],
  q: ["9"],
};

// Bytes that appear in JSON text. Used to score how JSON-like a decoded block
// is, so we can pick the right repair among several printable candidates.
const _JSON_BYTES = new Set<number>(
  Array.from(
    ' \t{}[]":,._-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ/+',
  ).map((c) => c.charCodeAt(0)),
);

/**
 * Higher when the decoded bytes look like JSON text. Non-printable bytes are
 * penalized heavily so a valid-JSON candidate always beats a garbage one.
 */
function _jsonScore(b: Uint8Array): number {
  let score = 0;
  for (const byte of b) {
    if (_JSON_BYTES.has(byte)) score += 2;
    else if (byte >= 32 && byte < 127) score += 1;
    else score -= 4;
  }
  return score;
}

function _decodedBytes(s: string): Uint8Array | null {
  return _b64urlToBytes(s);
}

// Cartesian product, matching itertools.product on the choice lists.
function _product<T>(choices: T[][]): T[][] {
  let result: T[][] = [[]];
  for (const pool of choices) {
    const next: T[][] = [];
    for (const prefix of result) {
      for (const item of pool) {
        next.push([...prefix, item]);
      }
    }
    result = next;
  }
  return result;
}

/**
 * Repair one base64url block (up to 4 chars). base64 decodes in independent
 * 4-char groups, so an OCR error stays local to its block. Among all
 * confusion-variant candidates we pick the one whose decoded bytes score most
 * JSON-like. Ties keep the original block.
 */
function _repairB64urlBlock(block: string): string {
  const amb: [number, string][] = [];
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch in _B64_AMBIG) amb.push([i, ch]);
  }
  if (amb.length === 0) return block;

  // A block is at most 4 chars, so all positions can be ambiguous. The search
  // is bounded (at most 3^4 = 81 candidates), which is cheap.
  const choices: [number, string][][] = [];
  for (const [i, ch] of amb) {
    choices.push([[i, ch], ...(_B64_AMBIG[ch].map((alt) => [i, alt] as [number, string]))]);
  }

  // scored entries: [score, isOriginal, string]
  const scored: [number, boolean, string][] = [];
  for (const combo of _product(choices)) {
    const cand = block.split("");
    for (const [i, c] of combo) cand[i] = c;
    const s = cand.join("");
    const b = _decodedBytes(s);
    if (b === null) continue;
    scored.push([_jsonScore(b), s === block, s]);
  }
  if (scored.length === 0) return block;
  // sort key: higher score first, and prefer the original block on a tie
  scored.sort((a, b) => {
    if (a[0] !== b[0]) return b[0] - a[0];
    return Number(b[1]) - Number(a[1]);
  });
  return scored[0][2];
}

/**
 * Try to recover a JWT segment that OCR garbled. First try as-is; then repair
 * the base64url block by block and re-check for valid JSON.
 */
function _recoverJsonSeg(
  seg: string,
): [Record<string, unknown> | null, string] {
  let obj = _decodeJsonSeg(seg);
  if (obj !== null) return [obj, seg];
  const blocks: string[] = [];
  for (let i = 0; i < seg.length; i += 4) blocks.push(seg.slice(i, i + 4));
  const repaired = blocks.map(_repairB64urlBlock).join("");
  obj = _decodeJsonSeg(repaired);
  if (obj !== null) return [obj, repaired];
  return [null, seg];
}

/**
 * A JWT is header.payload.signature where header and payload are base64url-
 * encoded JSON. We decode and confirm the header is JSON with an 'alg' field.
 * This kills random dotted base64 false positives. We attempt OCR recovery on
 * the header and payload so garbled but real JWTs still validate.
 */
function _jwtValid(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header] = _recoverJsonSeg(parts[0]);
  if (header === null || !("alg" in header)) return false;
  const [payload] = _recoverJsonSeg(parts[1]);
  return payload !== null;
}

// ---------------------------------------------------------------------------
// High-precision pattern detectors
// ---------------------------------------------------------------------------

interface _Pattern {
  name: string;
  secretType: string;
  regex: RegExp; // must be global (g) so we can finditer
  charset?: string; // for confusion-variant de-noising
  validator?: (value: string) => boolean;
  group: number; // which regex group is the secret
}

// Patterns adapted from gitleaks.toml conventions. Note JS regex uses the same
// syntax as Python here; all are global for iteration.
const _HIGH_PATTERNS: _Pattern[] = [
  {
    name: "AWS Access Key",
    secretType: "aws_access_key",
    regex: /\b(A(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA))[A-Z2-7]{16}\b/g,
    charset: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    group: 0,
  },
  {
    name: "Stripe Key",
    secretType: "stripe_key",
    regex: /\b([rs]k_(?:test|live)_[0-9A-Za-z]{16,99})\b/g,
    group: 1,
  },
  {
    name: "GitHub Token",
    secretType: "github_token",
    regex: /\b(gh[pousr]_[0-9A-Za-z]{36,255})\b/g,
    group: 1,
  },
  {
    // Real Google keys are AIza + 35 chars. We allow 33..37 to tolerate an
    // OCR-inserted or dropped character in the token run.
    name: "Google API Key",
    secretType: "google_api_key",
    regex: /\b(AIza[0-9A-Za-z_\-]{33,37})\b/g,
    group: 1,
  },
  {
    name: "Slack Token",
    secretType: "slack_token",
    regex: /\b(xox[baprs]-[0-9A-Za-z-]{10,64})\b/g,
    group: 1,
  },
  {
    name: "JWT",
    secretType: "jwt",
    regex: /\b(eyJ[A-Za-z0-9_\-]{5,}\.eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,})\b/g,
    validator: _jwtValid,
    group: 1,
  },
  {
    // OCR turns the surrounding dashes into em/en dashes or drops some, so we
    // only require dash-like runs (ASCII or unicode) around the phrase and make
    // the trailing run optional.
    name: "Private Key Header",
    secretType: "private_key",
    regex: /[-‐-―]{2,6}\s?BEGIN[ A-Z]*PRIVATE KEY(?:\s?[-‐-―]{2,6})?/g,
    group: 0,
  },
  {
    // Exclude structurally invalid SSNs: area 000, 666, and 900-999 are never
    // assigned; group 00 and serial 0000 are also invalid.
    name: "SSN",
    secretType: "ssn",
    regex: /\b((?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4})\b/g,
    group: 1,
  },
];

// Match all occurrences of a global regex, returning start/end/value per group.
function _finditer(
  regex: RegExp,
  line: string,
  group: number,
): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    // Compute the start offset of the requested group.
    let start: number;
    let value: string;
    if (group === 0) {
      start = m.index;
      value = m[0];
    } else {
      value = m[group] ?? "";
      // Locate the group within the full match. Groups here are the leading
      // capture so this is the whole match start in practice, but do it safely.
      const idxInMatch = m[0].indexOf(value);
      start = m.index + (idxInMatch >= 0 ? idxInMatch : 0);
    }
    out.push({ value, start, end: start + value.length });
    if (m.index === regex.lastIndex) regex.lastIndex++; // avoid zero-width loop
  }
  return out;
}

function _runHighPatterns(line: string, denoised: boolean): Finding[] {
  const out: Finding[] = [];
  for (const pat of _HIGH_PATTERNS) {
    for (const { value, start, end } of _finditer(pat.regex, line, pat.group)) {
      if (_isAllowlisted(value)) continue;
      if (pat.validator && !pat.validator(value)) continue;
      out.push(
        makeFinding({
          detector: pat.name,
          secretType: pat.secretType,
          tier: TIER_HIGH,
          matchedText: value,
          start,
          end,
          denoised,
        }),
      );
    }
  }
  return out;
}

// Letters OCR routinely reads in place of a card digit, mapped back to the
// digit they most likely are. Used only inside a card candidate run, so we
// never touch normal prose.
const _CARD_DIGIT_FIX: Record<string, string> = {
  l: "1",
  I: "1",
  i: "1",
  "|": "1",
  O: "0",
  o: "0",
  Q: "0",
  D: "0",
  S: "5",
  s: "5",
  B: "8",
  Z: "2",
  z: "2",
  G: "6",
  g: "9",
  q: "9",
  b: "6",
  T: "7",
};

function _escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A card candidate is a run of digits and card-confusable letters, with the
// OCR-inserted spaces/dashes that split the groups. We require it to contain at
// least one real digit so a plain word never becomes a candidate.
const _CARD_CHARCLASS =
  "0-9" +
  Object.keys(_CARD_DIGIT_FIX)
    .map((c) => _escapeRe(c))
    .join("");
const _CARD_CANDIDATE_RE = new RegExp(
  `(?<![0-9A-Za-z])(?=[0-9A-Za-z |]*[0-9])(?:[${_CARD_CHARCLASS}][ \\-]?){13,19}(?![0-9A-Za-z])`,
  "g",
);

/**
 * Turn a candidate run into 13..19 digits, mapping OCR letter-confusions back
 * to digits. Returns null if any character is neither a digit nor a known
 * confusable (after stripping spaces/dashes).
 */
function _cardDigits(span: string): string | null {
  const out: string[] = [];
  for (const ch of span) {
    if (ch === " " || ch === "-") continue;
    if (ch >= "0" && ch <= "9") out.push(ch);
    else if (ch in _CARD_DIGIT_FIX) out.push(_CARD_DIGIT_FIX[ch]);
    else return null;
  }
  return out.join("");
}

function _isPureDigits(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

function _runCardDetector(line: string, denoised: boolean): Finding[] {
  const out: Finding[] = [];
  _CARD_CANDIDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _CARD_CANDIDATE_RE.exec(line)) !== null) {
    const span = m[0];
    const digits = _cardDigits(span);
    if (m.index === _CARD_CANDIDATE_RE.lastIndex) _CARD_CANDIDATE_RE.lastIndex++;
    if (digits === null) continue;
    // A run that already was pure digits is a clean hit; a run that needed
    // letter-to-digit correction is an OCR recovery (flag it as denoised).
    const recovered = !_isPureDigits(span.replace(/ /g, "").replace(/-/g, ""));
    if (_luhnOk(digits)) {
      out.push(
        makeFinding({
          detector: "Credit Card (Luhn)",
          secretType: "credit_card",
          tier: TIER_HIGH,
          matchedText: span.trim(),
          start: m.index,
          end: m.index + span.length,
          denoised: denoised || recovered,
          notes:
            `${digits.length} digits, Luhn valid` +
            (recovered ? ", OCR-recovered" : ""),
        }),
      );
    }
  }
  return out;
}

/**
 * Best-effort char-level fix for AWS-style tokens where a fixed correction is
 * unambiguous. We target uppercase base32 runs after an 'AKIA'/'ASIA' etc
 * prefix. Deliberately narrow to avoid corrupting normal text. Returns a
 * possibly-corrected copy of the line.
 */
function _applyConfusionDenoise(line: string): string {
  return line.replace(/\bA[A-Z0-9O]{3}[A-Z0-9O]{16}\b/g, (token) => {
    const variants = _confusionVariants(
      token,
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    );
    return variants.length ? variants[0] : token;
  });
}

// ---------------------------------------------------------------------------
// Context-keyword detector (medium precision)
// ---------------------------------------------------------------------------

// key : value where the separator may be OCR-mangled. Value is anything that is
// not obviously a placeholder. This catches .env dumps and terminal echoes.
// Leading (?<![A-Za-z]) instead of \b so an underscore-joined prefix like
// DB_PASSWORD or MY_API_KEY still matches the keyword.
const _CONTEXT_RE =
  /(?<![A-Za-z])(password|passwd|pwd|api[_\- ]?key|secret[_\- ]?key|secret|access[_\- ]?token|auth[_\- ]?token|token|client[_\- ]?secret|db[_\- ]?pass\w*)\s*[:=;>\-]{1,3}\s*([^\s'"`,]{4,120}(?:[ ][^\s'"`,]{1,120})?)/gi;

const _VOWELS = new Set("aeiouAEIOU");

/**
 * Decide whether `tail` (the run after one OCR-inserted space) belongs to the
 * same secret as `head`. Conservative: only glue when the tail is short,
 * space-free, and not obviously a separate English word or sentence.
 */
function _looksLikeContinuation(head: string, tail: string): boolean {
  if (!tail) return false;
  if (tail.length > 24) return false;
  const headHasMix =
    /[0-9]/.test(head) || Array.from(head).some((c) => !/[0-9A-Za-z]/.test(c));
  let tailVowels = 0;
  for (const c of tail) if (_VOWELS.has(c)) tailVowels++;
  const tailLooksRandom = tailVowels <= Math.max(1, Math.floor(tail.length / 4));
  const tailIsAlpha = /^[A-Za-z]+$/.test(tail);
  return headHasMix && (tailLooksRandom || !tailIsAlpha);
}

function _runContextDetector(
  line: string,
  denoised: boolean,
  already: Finding[],
): Finding[] {
  const out: Finding[] = [];
  _CONTEXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _CONTEXT_RE.exec(line)) !== null) {
    const keyword = m[1];
    let val = m[2].trim();
    // Compute the raw value span: locate group 2 within the full match.
    const rawVal = m[2];
    const valOffsetInMatch = m[0].lastIndexOf(rawVal);
    let vstart = m.index + valOffsetInMatch;
    let vend = vstart + rawVal.length;
    // Trim the trailing whitespace that .trim() removed, keeping span aligned.
    // (rawVal has no leading/trailing spaces per regex except an internal one.)

    if (m.index === _CONTEXT_RE.lastIndex) _CONTEXT_RE.lastIndex++;

    // If the value captured a run across a single OCR-inserted space, decide
    // whether the tail is part of the same secret. If not, trim it off so we do
    // not over-redact a following real word.
    if (val.includes(" ")) {
      const spaceIdx = val.indexOf(" ");
      const head = val.slice(0, spaceIdx);
      const tail = val.slice(spaceIdx + 1);
      if (!_looksLikeContinuation(head, tail)) {
        val = head;
        vend = vstart + head.length;
      }
    }
    if (val.length < 4) continue;
    if (_isAllowlisted(val)) continue;
    // Skip if a high-precision detector already claimed this value; the high
    // finding is better. Overlap check on the value span.
    if (already.some((f) => !(f.end <= vstart || f.start >= vend))) continue;
    // Drop values that are clearly not secrets.
    if (["true", "false", "null", "none", "localhost"].includes(val.toLowerCase()))
      continue;
    out.push(
      makeFinding({
        detector: "Context Keyword",
        secretType: "context_secret",
        tier: TIER_MEDIUM,
        matchedText: val,
        start: vstart,
        end: vend,
        denoised,
        notes: `keyword '${keyword}'`,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Collapse findings that cover the same span/type, preferring the non-denoised,
 * higher-tier one.
 */
function _dedupe(findings: Finding[]): Finding[] {
  const tierRank: Record<string, number> = {
    [TIER_HIGH]: 0,
    [TIER_MEDIUM]: 1,
    [TIER_FUZZY]: 2,
  };
  const best = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.secretType}|${f.start}|${f.end}`;
    const cur = best.get(key);
    if (cur === undefined) {
      best.set(key, f);
      continue;
    }
    const fRank: [number, number] = [tierRank[f.tier], f.denoised ? 1 : 0];
    const curRank: [number, number] = [tierRank[cur.tier], cur.denoised ? 1 : 0];
    if (
      fRank[0] < curRank[0] ||
      (fRank[0] === curRank[0] && fRank[1] < curRank[1])
    ) {
      best.set(key, f);
    }
  }
  return Array.from(best.values());
}

function _charclass(c: string): string {
  const partners = _CONFUSION[c] ?? "";
  const chars = _escapeRe(c) + Array.from(partners).map(_escapeRe).join("");
  if (chars.length > 1) return `[${chars}]`;
  return chars;
}

/**
 * Try to move a finding's span back onto the raw line by locating a fuzzy
 * version of its matched text. If the exact text is not present (because de-
 * noising changed chars), fall back to matching on a relaxed pattern of the
 * same length so the redaction box still lands on the token.
 */
function _reanchor(f: Finding, rawLine: string): void {
  const idx = rawLine.indexOf(f.matchedText);
  if (idx !== -1) {
    f.start = idx;
    f.end = idx + f.matchedText.length;
    return;
  }
  const pat = Array.from(f.matchedText).map(_charclass).join("");
  let m: RegExpMatchArray | null = null;
  try {
    m = rawLine.match(new RegExp(pat));
  } catch {
    m = null;
  }
  if (m && m.index !== undefined) {
    f.start = m.index;
    f.end = m.index + m[0].length;
  }
}

/**
 * Run all detectors on a single OCR'd line and return findings whose spans are
 * relative to `line`.
 *
 * We scan three views of the line and reconcile:
 *   1. raw line
 *   2. space-collapsed line (OCR split a token)
 *   3. confusion-denoised line (OCR swapped chars in a known charset)
 * Views 2 and 3 change offsets, so their findings are re-anchored back to the
 * raw line by searching for the matched text; if that fails we keep the view
 * offset (still useful, box mapping degrades gracefully).
 */
export function scanLine(line: string): Finding[] {
  const findings: Finding[] = [];

  // View 1: raw
  let high = _runHighPatterns(line, false);
  high = high.concat(_runCardDetector(line, false));
  findings.push(...high);
  findings.push(..._runContextDetector(line, false, high));

  // View 2: space-collapsed
  const collapsed = _collapseTokenSpaces(line);
  if (collapsed !== line) {
    let cHigh = _runHighPatterns(collapsed, true);
    cHigh = cHigh.concat(_runCardDetector(collapsed, true));
    const cContext = _runContextDetector(collapsed, true, cHigh);
    for (const f of cHigh.concat(cContext)) {
      _reanchor(f, line);
      findings.push(f);
    }
  }

  // View 3: confusion-denoised (narrow, AWS-style)
  const fixed = _applyConfusionDenoise(line);
  if (fixed !== line) {
    for (const f of _runHighPatterns(fixed, true)) {
      _reanchor(f, line);
      findings.push(f);
    }
  }

  return _dedupe(findings);
}

/**
 * Top-level entry: run scanLine on each line and stamp the line index onto each
 * finding. Returns all findings across the document.
 */
export function scanText(lines: string[]): Finding[] {
  const all: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const f of scanLine(lines[i])) {
      f.lineIndex = i;
      all.push(f);
    }
  }
  return all;
}
