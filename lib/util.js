'use strict';
// Tiện ích dùng chung: nhận diện Hán tự, vị trí dòng/cột, Base64, tách literal JS, chuyển EJS -> JS.

// Hán tự + dấu câu CJK + ký tự fullwidth. Loại trừ 丨 (U+4E28) theo quy định.
const CJK_SRC =
  '[\\u3000-\\u303F\\u3400-\\u4DBF\\u4E00-\\u4E27\\u4E29-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF]' +
  '|[\\uD840-\\uD87F][\\uDC00-\\uDFFF]';
const CJK_RE = () => new RegExp(CJK_SRC, 'g');
const HAS_CJK = new RegExp(CJK_SRC);
const HAS_HANZI = /[㐀-䶿一-丧丩-鿿豈-﫿]/;

// Escape \uXXXX trỏ vào vùng CJK
const CJK_ESCAPE_RE = () => /\\u(3[0-9a-f]{3}|[4-9][0-9a-f]{3}|f[9a][0-9a-f]{2}|ff[0-9a-e][0-9a-f])/gi;
function escapeIsCjk(hex) {
  const cp = parseInt(hex, 16);
  if (cp === 0x4e28) return false;
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

class LineIndex {
  constructor(text) {
    this.starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  pos(idx) {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: idx - this.starts[lo] + 1 };
  }
}

function snippetAt(text, idx, len = 1, radius = 40) {
  const s = Math.max(0, idx - radius);
  const e = Math.min(text.length, idx + len + radius);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
}

// ---------------- Base64 ----------------
const BINARY_MIME = /^(image|audio|video|font)\/|application\/(octet-stream|font|x-font|wasm|pdf|zip)/i;
const B64_RE = () => /(data:([\w.+-]+\/[\w.+-]+)((?:;[\w-]+=[\w.-]+)*);base64,)?([A-Za-z0-9+/]{160,}={0,2})/g;

// Tìm các khối base64 là VĂN BẢN/CODE (bỏ qua ảnh/âm thanh/font/nhị phân)
function findTextBase64(text) {
  const out = [];
  const re = B64_RE();
  let m;
  while ((m = re.exec(text))) {
    const mime = m[2] || '';
    if (mime && BINARY_MIME.test(mime)) continue;
    const b64 = m[4];
    if (b64.length % 4 === 1) continue;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { continue; }
    const decoded = buf.toString('utf8');
    if (!looksLikeText(decoded)) continue;
    out.push({
      start: m.index + (m[1] ? m[1].length : 0),
      length: b64.length,
      b64,
      mime,
      decoded,
      padded: /=$/.test(b64),
    });
  }
  return out;
}

function looksLikeText(s) {
  if (!s || s.length < 20) return false;
  let bad = 0;
  const n = Math.min(s.length, 20000);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad / n < 0.005;
}

function encodeBase64Like(decoded, original) {
  let b = Buffer.from(decoded, 'utf8').toString('base64');
  if (!original.padded) b = b.replace(/=+$/, '');
  return b;
}

// ---------------- Tách literal chuỗi JS ----------------
// Trả về [{value, start, end, key}] ; key=true nếu literal đứng ở vị trí khóa (theo sau là ':' hoặc nằm trong ['...'])
function extractJsLiterals(code) {
  const out = [];
  out.regex = [];
  out.comments = [];
  const n = code.length;
  let i = 0;
  let lastSig = ''; // ký tự có nghĩa gần nhất (để đoán regex literal)
  while (i < n) {
    const ch = code[i];
    const nx = code[i + 1];
    if (ch === '/' && nx === '/') { const e = code.indexOf('\n', i); out.comments.push([i, e < 0 ? n : e]); i = e < 0 ? n : e; continue; }
    if (ch === '/' && nx === '*') { const e = code.indexOf('*/', i + 2); out.comments.push([i, e < 0 ? n : e + 2]); i = e < 0 ? n : e + 2; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const start = i;
      let j = i + 1, val = '';
      let depth = 0;
      while (j < n) {
        const c = code[j];
        if (c === '\\') { val += code.substr(j, 2); j += 2; continue; }
        if (ch === '`') {
          if (c === '$' && code[j + 1] === '{') { depth++; val += '${'; j += 2; continue; }
          if (depth > 0 && c === '}') { depth--; val += '}'; j++; continue; }
          if (depth === 0 && c === '`') break;
        } else if (c === ch || c === '\n') break;
        val += c; j++;
      }
      const end = Math.min(j + 1, n);
      // vị trí khóa?
      let k = end;
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
      let p = start - 1;
      while (p >= 0 && (code[p] === ' ' || code[p] === '\t')) p--;
      const isKey = (code[k] === ':' && code[k + 1] !== ':') || (code[p] === '[' && code[k] === ']');
      out.push({ value: val, start, end, key: isKey });
      i = end; lastSig = ch; continue;
    }
    if (ch === '/') {
      // đoán regex literal
      if (!lastSig || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || /\breturn\s*$|\btypeof\s*$/.test(code.slice(Math.max(0, i - 8), i))) {
        let j = i + 1, inClass = false;
        while (j < n && code[j] !== '\n') {
          const c = code[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true; else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          j++;
        }
        if (code[j] === '/') {
          j++;
          while (j < n && /[a-z]/i.test(code[j])) j++;
          out.regex.push([i, j]);
          i = j; lastSig = '/'; continue;
        }
      }
    }
    if (!/\s/.test(ch)) lastSig = ch;
    i++;
  }
  return out;
}

// ---------------- EJS ----------------
// Tách các khối code EJS kèm vị trí
function ejsBlocks(text) {
  const out = [];
  const re = /<%([_\-=#]?)([\s\S]*?)([_\-]?)%>/g;
  let m;
  while ((m = re.exec(text))) out.push({ kind: m[1], code: m[2], start: m.index + 2 + m[1].length, full: m[0], index: m.index });
  return out;
}

// Chuyển template EJS sang 1 thân hàm JS để kiểm tra cú pháp. Giữ số dòng tương ứng.
function ejsToJs(text) {
  const parts = [];
  const re = /<%([_\-=#]?)([\s\S]*?)([_\-]?)%>/g;
  let last = 0, m;
  // Giữ đúng số dòng: mỗi khối <% %> thêm 1 "\n;" (để chặn comment // cuối khối) → "nợ" 1 dòng,
  // trả nợ bằng cách bớt "\n" ở đoạn văn bản kế tiếp. Nếu không, số dòng báo lỗi lệch dần.
  let debt = 0;
  const lit = (s) => {
    let nl = (s.match(/\n/g) || []).length;
    const pay = Math.min(debt, nl); debt -= pay; nl -= pay;
    return '__o+=' + JSON.stringify(s) + ';' + '\n'.repeat(nl);
  };
  while ((m = re.exec(text))) {
    parts.push(lit(text.slice(last, m.index)));
    const kind = m[1];
    const code = m[2];
    if (kind === '#') parts.push('\n'.repeat((code.match(/\n/g) || []).length));
    else if (kind === '=' || kind === '-') parts.push('__o+=(' + code + ');');
    else { parts.push(code + '\n;'); debt++; }
    last = m.index + m[0].length;
  }
  parts.push(lit(text.slice(last)));
  return 'async function __ejs(__o){\n' + parts.join('') + '\n}';
}

// Khoảng cách Levenshtein (giới hạn)
function lev(a, b, max = 12) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function nearest(word, candidates, maxRatio = 0.4) {
  let best = null, bestD = Infinity;
  const max = Math.max(2, Math.floor(word.length * maxRatio));
  for (const c of candidates) {
    const d = lev(word.toLowerCase(), c.toLowerCase(), max);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= max ? best : null;
}

function parseRegexString(s) {
  if (typeof s !== 'string' || !s) return null;
  const m = s.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  try {
    if (m) return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
    return new RegExp(s, 'g');
  } catch (_) { return null; }
}

module.exports = {
  CJK_RE, HAS_CJK, HAS_HANZI, CJK_ESCAPE_RE, escapeIsCjk,
  LineIndex, snippetAt,
  findTextBase64, encodeBase64Like,
  extractJsLiterals, ejsBlocks, ejsToJs,
  lev, nearest, parseRegexString,
};
