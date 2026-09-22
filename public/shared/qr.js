// QR codes — generation (SVG) and scanning (camera), with no dependencies.
//
// Why hand-rolled: this app has no build step and no npm, and its network
// egress is locked down, so vendoring a library at deploy time isn't available.
// The encoder below is QR model 2, byte mode, error-correction level M, for
// versions 1–10 — which covers everything Charge Watch puts in a code (a ~40
// character claim URL on a printed slip, a ~20 character collection payload on
// a phone). It is exercised by tests/qr.test.mjs, which checks the Reed-Solomon
// output against its own syndromes (an independent property, not a restatement
// of the encoder) and re-reads each finished matrix back to the original bytes.
//
// Level M is the deliberate choice over L: a slip lives in a pocket and gets
// scanned in the dark, and M recovers from ~15% damage rather than ~7%.

(function () {
  // --- GF(256) for Reed-Solomon, primitive polynomial 0x11D -----------------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  // Generator polynomial for `degree` EC codewords: (x-a^0)(x-a^1)…
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      // Coefficients run highest-degree first, so multiplying by x keeps a term
      // at its own index in the longer array, and multiplying by a^i moves it
      // one place down. Swapping these two lines silently produces the REVERSED
      // generator, whose leading coefficient isn't 1 — the long division below
      // then never cancels, and every code comes out unreadable.
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  // Remainder of data·x^degree divided by the generator — the EC codewords.
  function rsEncode(data, degree) {
    const gen = rsGenerator(degree);
    const res = new Uint8Array(data.length + degree);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const factor = res[i];
      if (!factor) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  // --- Version tables (level M only) ----------------------------------------
  // [total codewords, EC codewords per block, blocks in group 1, data codewords
  //  per group-1 block, blocks in group 2, data codewords per group-2 block]
  const VERSIONS = {
    1:  [26,  10, 1, 16, 0, 0],
    2:  [44,  16, 1, 28, 0, 0],
    3:  [70,  26, 1, 44, 0, 0],
    4:  [100, 18, 2, 32, 0, 0],
    5:  [134, 24, 2, 43, 0, 0],
    6:  [172, 16, 4, 27, 0, 0],
    7:  [196, 18, 4, 31, 0, 0],
    8:  [242, 22, 2, 38, 2, 39],
    9:  [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
  const EC_M_BITS = 0x00; // level M is `00` in the format information

  const dataCodewords = (v) => {
    const [total, ec, g1, , g2] = VERSIONS[v];
    return total - ec * (g1 + g2);
  };

  function pickVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      const countBits = v < 10 ? 8 : 16;
      if (4 + countBits + byteLen * 8 <= dataCodewords(v) * 8) return v;
    }
    return null;
  }

  // --- Bit stream -----------------------------------------------------------
  function buildData(bytes, version) {
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);                              // byte mode
    push(bytes.length, version < 10 ? 8 : 16);    // character count
    for (const b of bytes) push(b, 8);

    const capacity = dataCodewords(version) * 8;
    // Terminator: up to four zero bits, or fewer if the stream is nearly full.
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const out = new Uint8Array(dataCodewords(version));
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      out[i / 8] = byte;
    }
    // Pad alternately with 0xEC / 0x11 as the specification requires.
    for (let i = bits.length / 8, alt = 0; i < out.length; i++, alt++) out[i] = alt % 2 ? 0x11 : 0xec;
    return out;
  }

  // Split into blocks, compute EC per block, then interleave both — the
  // interleaving is what lets a scratch across the code damage one codeword of
  // several blocks rather than destroying one block entirely.
  function interleave(data, version) {
    const [, ecLen, g1, d1, g2, d2] = VERSIONS[version];
    const blocks = [];
    let at = 0;
    for (let i = 0; i < g1; i++) { blocks.push(data.slice(at, at + d1)); at += d1; }
    for (let i = 0; i < g2; i++) { blocks.push(data.slice(at, at + d2)); at += d2; }
    const ec = blocks.map(b => rsEncode(b, ecLen));

    const out = [];
    const maxData = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of ec) out.push(e[i]);
    return Uint8Array.from(out);
  }

  // --- Matrix ---------------------------------------------------------------
  // `reserved` marks every module that carries function patterns or format
  // information, so data placement and masking both skip them.
  function blankMatrix(version) {
    const size = version * 4 + 17;
    const m = [], reserved = [];
    for (let i = 0; i < size; i++) { m.push(new Array(size).fill(0)); reserved.push(new Array(size).fill(0)); }

    const finder = (r, c) => {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        m[rr][cc] = inRing ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {            // timing patterns
      const bit = i % 2 === 0 ? 1 : 0;
      m[6][i] = bit; reserved[6][i] = 1;
      m[i][6] = bit; reserved[i][6] = 1;
    }

    for (const r of ALIGN[version]) for (const c of ALIGN[version]) {
      // Alignment patterns never overlap a finder.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
        reserved[r + dr][c + dc] = 1;
      }
    }

    m[size - 8][8] = 1; reserved[size - 8][8] = 1;  // the always-dark module

    for (let i = 0; i < 9; i++) {                   // format information areas
      if (!reserved[8][i]) { reserved[8][i] = 1; }
      if (!reserved[i][8]) { reserved[i][8] = 1; }
    }
    for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = 1; reserved[size - 1 - i][8] = 1; }

    if (version >= 7) {
      for (let i = 0; i < 18; i++) {
        const r = Math.floor(i / 3), c = i % 3;
        reserved[size - 11 + c][r] = 1;
        reserved[r][size - 11 + c] = 1;
      }
    }
    return { size, m, reserved };
  }

  // Zigzag placement: two-module-wide columns, right to left, alternating
  // upward and downward, skipping the vertical timing column at index 6.
  function placeData(mx, codewords) {
    const { size, m, reserved } = mx;
    let bitIndex = 0;
    const nextBit = () => {
      const byte = codewords[bitIndex >> 3];
      const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    };
    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) {
        const row = upward ? size - 1 - v : v;
        for (let c = 0; c < 2; c++) {
          const col = right - c;
          if (reserved[row][col]) continue;
          m[row][col] = nextBit();
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(mx, maskIndex) {
    const { size, m, reserved } = mx;
    const fn = MASKS[maskIndex];
    const out = m.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) out[r][c] ^= 1;
    }
    return out;
  }

  // BCH(15,5) format information, XOR'd with 0x5412 so an all-zero format is
  // still distinguishable from blank space.
  function formatBits(maskIndex) {
    const data = (EC_M_BITS << 3) | maskIndex;
    let rem = data << 10;
    for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
    return ((data << 10) | rem) ^ 0x5412;
  }

  function writeFormat(m, size, maskIndex) {
    const bits = formatBits(maskIndex);
    const at = (i) => (bits >> i) & 1;
    for (let i = 0; i <= 5; i++) m[8][i] = at(i);
    m[8][7] = at(6); m[8][8] = at(7); m[7][8] = at(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = at(i);
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = at(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = at(i);
    m[size - 8][8] = 1;
  }

  function writeVersion(m, size, version) {
    if (version < 7) return;
    const bits = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  // Penalty scoring, per the specification's four rules. The mask that scores
  // lowest is the one that produces the most scannable pattern.
  function penalty(m, size) {
    let score = 0;
    const runScore = (line) => {
      let s = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
      return s;
    };
    const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const hasPattern = (line, at) => {
      for (let i = 0; i < 11; i++) if (line[at + i] !== PATTERN[i]) return false;
      return true;
    };
    const hasPatternRev = (line, at) => {
      for (let i = 0; i < 11; i++) if (line[at + i] !== PATTERN[10 - i]) return false;
      return true;
    };

    for (let r = 0; r < size; r++) {
      const row = m[r], col = m.map(x => x[r]);
      score += runScore(row) + runScore(col);
      for (let i = 0; i + 11 <= size; i++) {
        if (hasPattern(row, i) || hasPatternRev(row, i)) score += 40;
        if (hasPattern(col, i) || hasPatternRev(col, i)) score += 40;
      }
    }
    for (let r = 0; r + 1 < size; r++) for (let c = 0; c + 1 < size; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  // Encode `text` (UTF-8) into a boolean matrix. Returns null if it is too long
  // for version 10 — the caller shows the code as text instead of a broken QR.
  function qrMatrix(text) {
    const bytes = new TextEncoder().encode(String(text));
    const version = pickVersion(bytes.length);
    if (!version) return null;

    const codewords = interleave(buildData(bytes, version), version);
    const mx = blankMatrix(version);
    placeData(mx, codewords);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(mx, mask);
      writeFormat(candidate, mx.size, mask);
      writeVersion(candidate, mx.size, version);
      const score = penalty(candidate, mx.size);
      if (!best || score < best.score) best = { score, modules: candidate, mask };
    }
    return { size: mx.size, version, mask: best.mask, modules: best.modules.map(r => r.map(Boolean)) };
  }

  // Render as SVG: resolution-independent, prints crisply on a slip, and needs
  // no canvas. One <path> for every dark module keeps the markup small.
  function qrSvg(text, opts) {
    opts = opts || {};
    const qr = qrMatrix(text);
    if (!qr) return "";
    // FOUR modules of quiet zone, which is what the specification requires. Two
    // looked fine on screen and failed to scan on a phone: the quiet zone is
    // how a camera finds the code's edges at all, and the white plate's padding
    // around it is not a substitute because the scanner sees the whole frame.
    const quiet = opts.quiet == null ? 4 : opts.quiet;
    const span = qr.size + quiet * 2;

    // Emit one rectangle per HORIZONTAL RUN of dark modules rather than one per
    // module. Drawn separately, adjacent squares can land on sub-pixel bounds
    // and leave hairline seams once `crispEdges` snaps them — white lines
    // through the dark blocks, which is exactly what stops a detector locking
    // on. Merging the runs removes almost every internal seam and shrinks the
    // markup at the same time.
    let d = "";
    for (let r = 0; r < qr.size; r++) {
      let c = 0;
      while (c < qr.size) {
        if (!qr.modules[r][c]) { c++; continue; }
        let len = 1;
        while (c + len < qr.size && qr.modules[r][c + len]) len++;
        d += `M${c + quiet} ${r + quiet}h${len}v1h-${len}z`;
        c += len;
      }
    }
    const label = opts.label ? String(opts.label).replace(/[<>&"]/g, "") : "QR code";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="100%" height="100%" role="img" aria-label="${label}" shape-rendering="crispEdges">`
      + `<rect width="${span}" height="${span}" fill="${opts.bg || "#ffffff"}"/>`
      + `<path d="${d}" fill="${opts.fg || "#000000"}"/></svg>`;
  }

  // --- Scanning -------------------------------------------------------------
  // BarcodeDetector where the browser has it (Android Chrome, desktop Chrome and
  // Edge). Where it doesn't — notably every browser on iOS — this reports
  // unsupported and the console falls back to typing the code, which is why the
  // collection screen always shows a keypad beside the camera. The printed slip
  // additionally carries a plain URL, so a phone's own camera app opens it with
  // no scanner at all.
  const scanSupported = () => typeof window !== "undefined" && "BarcodeDetector" in window;

  async function scanStart(video, onResult, onError) {
    if (!scanSupported()) { onError && onError("unsupported"); return null; }
    let stream, stop = false, detector;
    try {
      detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (e) {
      onError && onError(e && e.name === "NotAllowedError" ? "denied" : "camera");
      return null;
    }
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    try { await video.play(); } catch (e) {}

    const tick = async () => {
      if (stop) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length && codes[0].rawValue) {
          onResult(codes[0].rawValue);
          // One result per scan session: the caller decides whether to resume,
          // so a code can't fire twice while a confirmation dialog is open.
          return;
        }
      } catch (e) {}
      setTimeout(tick, 220);
    };
    tick();

    return () => {
      stop = true;
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { video.srcObject = null; } catch (e) {}
    };
  }

  const api = { matrix: qrMatrix, svg: qrSvg, scanSupported, scanStart };
  if (typeof window !== "undefined") { window.cwQr = api; }
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})();
