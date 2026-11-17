'use strict';
// Lõi phân tích: so sánh File RAW ↔ File DỊCH theo checklist.
const U = require('./util');
const { extractZones } = require('./extract');
const { findBadFonts } = require('./fonts');
const { checkSyntax, pool } = require('./jscheck');

const MAX_ISSUES_PER_RULE = 400;

const RULES = {
  missing_item: { cat: 'struct', title: 'Thiếu mục so với RAW' },
  extra_item: { cat: 'struct', title: 'Mục mới không có trong RAW' },
  empty_field: { cat: 'struct', title: 'Trường bị rỗng' },
  cjk: { cat: 'cjk', title: 'Còn Hán tự / dấu câu CJK' },
  cjk_regex_class: { cat: 'cjk', title: 'Ký tự CJK trong lớp regex (ngoại lệ hợp lệ?)' },
  cjk_escape: { cat: 'cjk', title: 'Chuỗi \\uXXXX trỏ tới Hán tự' },
  cjk_b64: { cat: 'cjk', title: 'Hán tự trong Base64 (code/văn bản)' },
  font: { cat: 'ui', title: 'Font không hỗ trợ tiếng Việt' },
  ellipsis: { cat: 'ui', title: 'Cắt chữ (ellipsis / line-clamp)' },
  overflow: { cat: 'ui', title: 'overflow: hidden (cần xem lại)' },
  maxlength: { cat: 'ui', title: 'maxlength không đổi so với RAW' },
  mdlink: { cat: 'syntax', title: 'URL bị biến thành link Markdown' },
  url_lost: { cat: 'syntax', title: 'URL trong RAW bị mất/biến dạng' },
  bracket_path: { cat: 'sync', title: "Đường dẫn dạng Cha['Con'] trong chuỗi" },
  tokens: { cat: 'struct', title: 'Số lượng thẻ kỹ thuật khác RAW' },
  skeleton: { cat: 'struct', title: 'Khung code khác RAW (thiếu/lặp/sai code)' },
  syntax: { cat: 'syntax', title: 'Lỗi cú pháp JS / EJS' },
  syntax_raw_too: { cat: 'syntax', title: 'Lỗi cú pháp (RAW cũng lỗi khi tách riêng)' },
  glossary_conflict: { cat: 'sync', title: 'Một thuật ngữ gốc bị dịch nhiều kiểu' },
  unknown_var: { cat: 'sync', title: 'Tên biến không có trong initvar/schema' },
  getwi_missing: { cat: 'sync', title: 'getwi() trỏ tới mục Worldbook không tồn tại' },
  marker_regex: { cat: 'sync', title: 'Đánh dấu không còn khớp findRegex' },
  findregex_changed: { cat: 'sync', title: 'findRegex (không chứa Hán tự) bị thay đổi' },
  data_sync: { cat: 'sync', title: 'Trường gốc và data.* không đồng bộ' },
  card_name: { cat: 'sync', title: 'Tên thẻ trong code không khớp' },
  align_fail: { cat: 'sync', title: 'Không căn được chuỗi RAW↔DỊCH' },
};

class Collector {
  constructor() { this.list = []; this.counter = new Map(); this.overflow = new Map(); }
  add(issue) {
    const k = (issue.item || '') + '|' + (issue.field || '') + '|' + issue.rule;
    const c = (this.counter.get(k) || 0) + 1;
    this.counter.set(k, c);
    if (c > MAX_ISSUES_PER_RULE) { this.overflow.set(k, issue); return; }
    this.list.push(issue);
  }
  finalize() {
    for (const [k, iss] of this.overflow) {
      const total = this.counter.get(k);
      this.list.push({ ...iss, line: null, col: null, snippet: '', msg: `… và ${total - MAX_ISSUES_PER_RULE} lỗi cùng loại khác (đã ẩn bớt)`, more: true });
    }
    return this.list;
  }
}

// ---------- phạm vi kiểm tra trong greeting: chỉ khối kỹ thuật ----------
function technicalRanges(text) {
  const ranges = [];
  const add = (re) => { let m; while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]); };
  add(/<%[\s\S]*?%>/g);
  add(/<(UpdateVariable|JSONPatch|initvar|InitVar)\b[^>]*>[\s\S]*?(<\/\1>|$)/g);
  add(/\{\{(?:getvar|setvar|getglobalvar|setglobalvar)::[^}]*\}\}/gi);
  return ranges.sort((a, b) => a[0] - b[0]);
}
const inRanges = (ranges, i) => !ranges || ranges.some(([s, e]) => i >= s && i < e);

// ---------- quét Hán tự ----------
function scanCjk(text, ranges, emit, base = {}) {
  const re = U.CJK_RE();
  const li = new U.LineIndex(text);
  let m, runStart = -1, runEnd = -1;
  const flush = () => {
    if (runStart < 0) return;
    const run = text.slice(runStart, runEnd);
    const p = li.pos(runStart);
    // ngoại lệ: nằm trong lớp ký tự regex [...]
    const lineStart = text.lastIndexOf('\n', runStart) + 1;
    const before = text.slice(lineStart, runStart);
    const ob = before.lastIndexOf('[');
    let inClass = false;
    if (ob >= 0 && /[\/|(:?]$/.test(before.slice(0, ob))) {
      const lineEnd = text.indexOf('\n', runEnd);
      const after = text.slice(runEnd, lineEnd < 0 ? text.length : lineEnd);
      const cb = after.indexOf(']');
      const inner = before.slice(ob + 1) + run + (cb >= 0 ? after.slice(0, cb) : '');
      inClass = cb >= 0 && !/[{}'"`:]|\.\.\./.test(inner) && /^[\/+*?{)|\]]/.test(after.slice(cb + 1));
    }
    emit({ ...base, rule: inClass ? 'cjk_regex_class' : 'cjk', sev: inClass ? 'info' : 'error', line: p.line, col: p.col, text: run, snippet: U.snippetAt(text, runStart, run.length), msg: `“${run}”` });
    runStart = -1;
  };
  while ((m = re.exec(text))) {
    if (!inRanges(ranges, m.index)) continue;
    if (runStart >= 0 && m.index <= runEnd + 0) { runEnd = m.index + m[0].length; continue; }
    flush();
    runStart = m.index; runEnd = m.index + m[0].length;
  }
  flush();
  // \uXXXX
  const er = U.CJK_ESCAPE_RE();
  while ((m = er.exec(text))) {
    if (!inRanges(ranges, m.index) || !U.escapeIsCjk(m[1])) continue;
    const p = li.pos(m.index);
    emit({ ...base, rule: 'cjk_escape', sev: 'warn', line: p.line, col: p.col, text: m[0], snippet: U.snippetAt(text, m.index, 6), msg: `${m[0]} = “${String.fromCharCode(parseInt(m[1], 16))}” (chỉ giữ nếu API bắt buộc key tiếng Trung)` });
  }
}

function scanUi(text, ranges, emit, base) {
  const li = new U.LineIndex(text);
  for (const f of findBadFonts(text)) {
    if (!inRanges(ranges, f.index)) continue;
    const p = li.pos(f.index);
    emit({ ...base, rule: 'font', sev: 'error', line: p.line, col: p.col, text: f.font, snippet: U.snippetAt(text, f.index, f.font.length), msg: `Font “${f.font}”`, fixable: true });
  }
  const pats = [
    [/text-overflow\s*:\s*ellipsis/gi, 'ellipsis', 'warn'],
    [/-webkit-line-clamp\s*:\s*\d+/gi, 'ellipsis', 'warn'],
    [/textOverflow\s*[:=]\s*['"]ellipsis/g, 'ellipsis', 'warn'],
    [/overflow(?:-[xy])?\s*:\s*hidden/gi, 'overflow', 'info'],
  ];
  for (const [re, rule, sev] of pats) {
    let m;
    while ((m = re.exec(text))) {
      if (!inRanges(ranges, m.index)) continue;
      const p = li.pos(m.index);
      emit({ ...base, rule, sev, line: p.line, col: p.col, snippet: U.snippetAt(text, m.index, m[0].length), msg: m[0], fixable: rule === 'ellipsis' });
    }
  }
}

function scanMdLinks(text, ranges, emit, base) {
  const li = new U.LineIndex(text);
  const re = /\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    if (!inRanges(ranges, m.index)) continue;
    const p = li.pos(m.index);
    emit({ ...base, rule: 'mdlink', sev: 'error', line: p.line, col: p.col, snippet: U.snippetAt(text, m.index, m[0].length), msg: `${m[0].slice(0, 120)} → ${m[1]}`, fixable: true });
  }
}

const URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+/g;
function compareUrls(rawText, transText, emit, base) {
  const rawUrls = new Set((rawText.match(URL_RE) || []).map((u) => u.replace(/[.,;:)]+$/, '')));
  if (!rawUrls.size) return;
  const tli = new U.LineIndex(transText);
  for (const u of rawUrls) {
    if (transText.includes(u)) continue;
    // tìm vị trí gần đúng: domain
    const host = (u.match(/^https?:\/\/[^/]+/) || [u])[0];
    const at = transText.indexOf(host);
    const p = at >= 0 ? tli.pos(at) : { line: null, col: null };
    emit({ ...base, rule: 'url_lost', sev: 'error', line: p.line, col: p.col, snippet: at >= 0 ? U.snippetAt(transText, at, u.length, 60) : '', msg: `RAW có “${u}” nhưng DỊCH không còn nguyên văn` });
  }
}

const TOKENS = ['<%', '%>', '{{user}}', '{{char}}', '<UpdateVariable>', '</UpdateVariable>', '<JSONPatch>', '</JSONPatch>', '<script', '</script>', '<style', '</style>', 'import(', 'export ', '=>', 'function', '丨', '$1', '$2', '$3', '{0}', '%s', 'getvar(', 'setvar(', 'getwi(', 'getMessageVar(', 'z.object(', '_.get(', '_.set(', 'eventOn(', 'await '];
function countTokens(text) {
  const c = {};
  for (const t of TOKENS) { let n = 0, i = 0; while ((i = text.indexOf(t, i)) >= 0) { n++; i += t.length; } if (n) c[t] = n; }
  return c;
}
function compareTokens(rawText, transText, emit, base) {
  const a = countTokens(rawText), b = countTokens(transText);
  const diffs = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[t] || 0) !== (b[t] || 0)) diffs.push(`${t}: RAW ${a[t] || 0} / DỊCH ${b[t] || 0}`);
  if (diffs.length) emit({ ...base, rule: 'tokens', sev: 'warn', line: null, msg: diffs.join(' · ') });
}

// Khung code: bỏ chuỗi, comment, regex literal, khoảng trắng; định danh có ký tự không-ASCII (tên biến tiếng Trung/Việt) → "I"
const ID_CHAR = /[A-Za-z0-9_$À-￿]/;
function skeleton(code) {
  const lits = U.extractJsLiterals(code);
  const skip = [...lits.map((l) => [l.start, l.end, 'S']), ...lits.regex.map(([a, b]) => [a, b, 'R']), ...lits.comments.map(([a, b]) => [a, b, ''])].sort((a, b) => a[0] - b[0]);
  const keep = [];
  const pos = [];
  const ids = [];
  let k = 0;
  for (let i = 0; i < code.length; i++) {
    while (k < skip.length && skip[k][1] <= i) k++;
    if (k < skip.length && i >= skip[k][0]) { if (skip[k][2]) { keep.push(skip[k][2]); pos.push(i); } i = skip[k][1] - 1; continue; }
    const c = code[i];
    if (ID_CHAR.test(c)) {
      let j = i;
      while (j < code.length && ID_CHAR.test(code[j])) j++;
      const id = code.slice(i, j);
      if (/[^\x00-\x7f]/.test(id)) { keep.push('I'); pos.push(i); ids.push({ value: id, start: i, key: true }); }
      else for (let q = i; q < j; q++) { keep.push(code[q]); pos.push(q); }
      i = j - 1; continue;
    }
    if (/\s/.test(c)) continue;
    keep.push(c); pos.push(i);
  }
  // Chuẩn hoá các cách viết tương đương khi dịch tên khoá:  a.键 ≡ a['Khóa']  ·  {键: …} ≡ {'Khóa': …}
  const K = [], P = [];
  for (let i = 0; i < keep.length; i++) {
    const t = keep[i];
    if (t === '[' && keep[i + 1] === 'S' && keep[i + 2] === ']' && i > 0 && /[\w$)\]I.]/.test(keep[i - 1])) {
      if (keep[i - 1] !== '.') { K.push('.'); P.push(pos[i]); }
      K.push('I'); P.push(pos[i]); i += 2; continue;
    }
    if ((t === 'S' || t === 'I') && keep[i + 1] === ':') { K.push('K'); P.push(pos[i]); continue; }
    K.push(t); P.push(pos[i]);
  }
  return { s: K.join(''), pos: P, ids };
}
function compareSkeleton(rawCode, transCode, emit, base, lineOffset = 0) {
  if (rawCode.length > 3e6 || transCode.length > 3e6) return;
  const a = skeleton(rawCode), b = skeleton(transCode);
  if (a.s === b.s) return;
  let i = 0;
  while (i < a.s.length && i < b.s.length && a.s[i] === b.s[i]) i++;
  const tpos = b.pos[Math.min(i, b.pos.length - 1)] ?? 0;
  const rpos = a.pos[Math.min(i, a.pos.length - 1)] ?? 0;
  const tl = new U.LineIndex(transCode).pos(tpos);
  const rl = new U.LineIndex(rawCode).pos(rpos);
  const ratio = b.s.length / Math.max(1, a.s.length);
  emit({ ...base, rule: 'skeleton', sev: ratio < 0.7 || ratio > 1.4 ? 'error' : 'warn', line: tl.line + lineOffset, col: tl.col, rawLine: rl.line + lineOffset, snippet: U.snippetAt(transCode, tpos, 1, 60), rawSnippet: U.snippetAt(rawCode, rpos, 1, 60), msg: `Khung code lệch RAW từ dòng ${tl.line + lineOffset} (RAW dòng ${rl.line + lineOffset}); độ dài khung DỊCH/RAW = ${(ratio * 100).toFixed(0)}%` });
}

function scanBracketPaths(code, emit, base, lineOffset = 0) {
  const li = new U.LineIndex(code);
  for (const l of U.extractJsLiterals(code)) {
    if (/^[^\[\]'"\n]+(\[['"][^'"\]]+['"]\])+/.test(l.value) && U.HAS_CJK.test(l.value) === false && /[^\x00-\x7f]/.test(l.value)) {
      const p = li.pos(l.start);
      const fix = l.value.replace(/\[['"]([^'"\]]+)['"]\]/g, '.$1');
      emit({ ...base, rule: 'bracket_path', sev: 'warn', line: p.line + lineOffset, col: p.col, snippet: U.snippetAt(code, l.start, l.end - l.start), msg: `“${l.value}” → nên là “${fix}” nếu hàm tra cứu dùng dấu chấm` });
    }
  }
}

// ---------- tách khối code ----------
function scriptBlocks(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    if (!body.trim()) continue;
    const type = (attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/javascript|module|ecmascript|babel/i.test(type)) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    out.push({ code: body, start, module: /module/i.test(type || '') });
  }
  return out;
}

// ---------- phân tích 1 cặp trường ----------
async function analyzeField(ctx, item, field, rawText, transText, emit, depth = 0, b64Index = null) {
  const base = { item: item.key, field: field.name, ...(b64Index != null ? { b64: b64Index } : {}) };
  const isGreeting = item.zone === 'greeting';
  const ranges = isGreeting ? technicalRanges(transText) : null;
  if (isGreeting && !ranges.length) return;

  if (rawText && !transText.trim()) emit({ ...base, rule: 'empty_field', sev: 'error', msg: 'RAW có nội dung nhưng DỊCH rỗng' });

  scanCjk(transText, ranges, emit, base);
  if (field.code === 'text') return;
  scanUi(transText, ranges, emit, base);
  scanMdLinks(transText, ranges, emit, base);
  if (rawText != null) compareUrls(rawText, transText, emit, base);
  if (rawText != null && field.code !== 'regex') compareTokens(rawText, transText, emit, base);

  // Base64 chứa code/văn bản
  if (depth < 2) {
    const tb = U.findTextBase64(transText);
    const rb = rawText ? U.findTextBase64(rawText) : [];
    for (let k = 0; k < tb.length; k++) {
      const key = `${item.key}|${field.name}|${k}`;
      ctx.decoded[key] = { trans: tb[k].decoded, raw: rb[k] ? rb[k].decoded : null, line: new U.LineIndex(transText).pos(tb[k].start).line };
      const sub = [];
      await analyzeField(ctx, item, { ...field, code: /<\w+[\s>]/.test(tb[k].decoded) ? 'html' : 'js' }, rb[k] ? rb[k].decoded : null, tb[k].decoded, (iss) => {
        if (iss.rule === 'cjk') iss = { ...iss, rule: 'cjk_b64' };
        sub.push(iss);
        emit({ ...iss, b64: k, b64Line: ctx.decoded[key].line });
      }, depth + 1, k);
    }
  }

  // Cú pháp + khung code
  const pairs = [];
  if (field.code === 'js') pairs.push({ raw: rawText, trans: transText, off: 0, label: 'script' });
  else if (field.code === 'html') {
    const ts = scriptBlocks(transText), rs = rawText ? scriptBlocks(rawText) : [];
    const tli = new U.LineIndex(transText);
    ts.forEach((b, k) => pairs.push({ raw: rs[k] ? rs[k].code : null, trans: b.code, off: tli.pos(b.start).line - 1, label: `<script> #${k + 1}` }));
  } else if ((field.code === 'ejs') && /<%/.test(transText)) {
    pairs.push({ raw: rawText && /<%/.test(rawText) ? U.ejsToJs(rawText) : null, trans: U.ejsToJs(transText), off: -1, label: 'EJS', ejs: true, rawSrc: rawText, transSrc: transText });
  }
  for (const p of pairs) {
    ctx.syntaxJobs.push(async () => {
      const r = await checkSyntax(p.trans);
      if (r.ok) return;
      const rr = p.raw != null ? await checkSyntax(p.raw) : { ok: true };
      const line = r.line != null ? r.line + p.off : null;
      const src = p.ejs ? p.transSrc : transText;
      let snippet = '';
      if (line != null) { const lines = src.split('\n'); snippet = (lines[line - 1] || '').trim().slice(0, 200); }
      emit({ ...base, rule: rr.ok ? 'syntax' : 'syntax_raw_too', sev: rr.ok ? 'error' : 'info', line, snippet, msg: `${p.label}: ${r.message}${rr.ok ? '' : ' (RAW cũng báo lỗi khi kiểm tra tách riêng → có thể do macro/placeholder)'}` });
    });
    if (p.raw != null && !p.ejs) compareSkeleton(p.raw, p.trans, emit, base, p.off);
    if (!p.ejs) scanBracketPaths(p.trans, emit, base, p.off);
  }
  if (field.code === 'ejs' && rawText && /<%/.test(transText)) {
    const rc = U.ejsBlocks(rawText).filter((b) => b.kind !== '#').map((b) => b.code).join('\n;\n');
    const tc = U.ejsBlocks(transText).filter((b) => b.kind !== '#').map((b) => b.code).join('\n;\n');
    compareSkeletonEjs(rc, tc, transText, emit, base);
  }
  // maxlength
  if (rawText && /maxlength/i.test(transText)) {
    const rm = (rawText.match(/maxlength\s*=\s*["']?(\d+)/gi) || []).join();
    const tm = (transText.match(/maxlength\s*=\s*["']?(\d+)/gi) || []).join();
    if (rm && rm === tm) emit({ ...base, rule: 'maxlength', sev: 'info', msg: `maxlength giữ nguyên như RAW (${rm.slice(0, 120)}) — tiếng Việt thường dài hơn, cân nhắc nới.` });
  }
}

function compareSkeletonEjs(rc, tc, transText, emit, base) {
  const a = skeleton(rc), b = skeleton(tc);
  if (a.s === b.s) return;
  let i = 0;
  while (i < a.s.length && i < b.s.length && a.s[i] === b.s[i]) i++;
  // tìm vị trí trong transText: lấy đoạn code quanh vị trí lệch
  const near = tc.slice(Math.max(0, (b.pos[i] ?? 0) - 20), (b.pos[i] ?? 0) + 20).trim().split('\n')[0];
  const at = near ? transText.indexOf(near) : -1;
  const p = at >= 0 ? new U.LineIndex(transText).pos(at) : { line: null };
  const ratio = b.s.length / Math.max(1, a.s.length);
  emit({ ...base, rule: 'skeleton', sev: ratio < 0.7 || ratio > 1.4 ? 'error' : 'warn', line: p.line, snippet: U.snippetAt(tc, b.pos[i] ?? 0, 1, 60), rawSnippet: U.snippetAt(rc, a.pos[i] ?? 0, 1, 60), msg: `Khung code EJS lệch RAW (độ dài DỊCH/RAW = ${(ratio * 100).toFixed(0)}%)` });
}

// ---------- căn literal → bảng thuật ngữ ----------
function literalsFor(field, text) {
  if (!text) return [];
  if (field.code === 'yaml') return yamlKeys(text).map((k) => ({ value: k.key, key: true, start: k.index }));
  if (field.code === 'js') return U.extractJsLiterals(text);
  if (field.code === 'html') return scriptBlocks(text).flatMap((b) => U.extractJsLiterals(b.code).map((l) => ({ ...l, start: l.start + b.start })));
  if (field.code === 'ejs') return U.ejsBlocks(text).flatMap((b) => U.extractJsLiterals(b.code).map((l) => ({ ...l, start: l.start + b.start })));
  return [];
}
function jsonPatchPaths(text) {
  const out = [];
  const re = /"path"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) out.push({ value: m[1], key: true, start: m.index, path: true });
  return out;
}

function yamlKeys(text) {
  const out = [];
  const re = /^([ \t]*)(?:-[ \t]+)?(['"]?)([^:#\n'"][^:\n]*?)\2[ \t]*:(?=[ \t]|$)/gm;
  let m;
  while ((m = re.exec(text))) out.push({ key: m[3].trim(), indent: m[1].length, index: m.index + m[1].length });
  return out;
}

// Căn chuỗi: dùng literal ASCII giống hệt nhau làm "mốc"; giữa 2 mốc chỉ ghép khi số lượng bằng nhau.
function alignLists(a, b) {
  if (a.length === b.length) {
    // kiểm tra nhanh: mọi literal ASCII phải khớp vị trí
    let ok = true;
    for (let i = 0; i < a.length; i++) if (!/[^\x00-\x7f]/.test(a[i].value) && a[i].value !== b[i].value) { ok = false; break; }
    if (ok) return { pairs: a.map((x, i) => [x, b[i]]), exact: true };
  }
  const isAnchor = (x) => !/[^\x00-\x7f]/.test(x.value) && x.value.length > 0;
  const A = a.map((x, i) => ({ x, i })).filter((o) => isAnchor(o.x));
  const B = b.map((x, i) => ({ x, i })).filter((o) => isAnchor(o.x));
  const n = A.length, m = B.length;
  if (n * m > 2.5e7) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i].x.value === B[j].x.value ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const anchors = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].x.value === B[j].x.value) { anchors.push([A[i].i, B[j].i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  anchors.push([a.length, b.length]);
  const pairs = [];
  let pa = -1, pb = -1, skipped = 0;
  for (const [ai, bi] of anchors) {
    const segA = a.slice(pa + 1, ai), segB = b.slice(pb + 1, bi);
    if (segA.length === segB.length) segA.forEach((x, k) => pairs.push([x, segB[k]]));
    else skipped += segA.length;
    pa = ai; pb = bi;
  }
  return { pairs, exact: false, skipped };
}

function termLike(zh) {
  return zh.length >= 1 && zh.length <= 24 && U.HAS_HANZI.test(zh) && !/[\s。，！？；\n]/.test(zh) && !/[<>{}()=]/.test(zh);
}

function buildGlossary(pairsByField) {
  const g = new Map();
  const add = (zh, vi, loc) => {
    zh = zh.trim(); vi = vi.trim();
    if (!termLike(zh)) return;
    if (!g.has(zh)) g.set(zh, new Map());
    const m = g.get(zh);
    if (!m.has(vi)) m.set(vi, []);
    m.get(vi).push(loc);
  };
  for (const { pairs, loc } of pairsByField) {
    for (const [r, t] of pairs) {
      const L = { ...loc, key: !!(r.key || t.key), line: t.line };
      if (r.path || /^[^\s]+([./][^\s./]+)+$/.test(r.value)) {
        const sep = r.value.includes('/') ? '/' : '.';
        const rs = r.value.split(sep), ts = t.value.split(sep);
        if (rs.length === ts.length && rs.length > 1) { rs.forEach((s, k) => add(s, ts[k], { ...L, key: true })); continue; }
      }
      add(r.value, t.value, L);
    }
  }
  const out = [];
  for (const [zh, m] of g) {
    const variants = [...m.entries()].map(([vi, locs]) => ({ vi, count: locs.length, locs: locs.slice(0, 12), key: locs.some((l) => l.key) }));
    variants.sort((a, b) => b.count - a.count);
    out.push({ zh, variants, conflict: variants.length > 1, keyCtx: variants.some((v) => v.key), untranslated: variants.some((v) => U.HAS_HANZI.test(v.vi)) });
  }
  out.sort((a, b) => (b.conflict - a.conflict) || (b.keyCtx - a.keyCtx) || a.zh.localeCompare(b.zh));
  return out;
}

// ---------- kiểm tra tham chiếu biến ----------
function collectKnownVars(items, cardSide) {
  const known = new Set();
  for (const it of items) {
    const f = it.fields.find((x) => x.name === 'content');
    if (!f) continue;
    const text = it[cardSide];
    if (it.zone === 'worldbook' && it.isInitvar && text) yamlKeys(text).forEach((k) => known.add(k.key));
    if (it.zone === 'script' && text && /z\.object|registerMvuSchema|zod/.test(text)) {
      U.extractJsLiterals(text).forEach((l) => { if (l.key) known.add(l.value); });
      // khóa không đặt trong nháy: Ten_khoa: z.
      const re = /([^\s{},:'"`()[\]]+)\s*:\s*z\./g; let m;
      while ((m = re.exec(text))) known.add(m[1]);
    }
  }
  // greetings initvar
  for (const it of items) if (it.zone === 'greeting' && it[cardSide]) {
    const m = it[cardSide].match(/<initvar>([\s\S]*?)<\/initvar>/i);
    if (m) yamlKeys(m[1]).forEach((k) => known.add(k.key));
  }
  return known;
}

function collectVarRefs(items, cardSide) {
  const refs = [];
  const segs = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  for (const it of items) {
    if (!it.inScope) continue;
    for (const f of it.fields) {
      const text = f[cardSide];
      if (!text || f.code === 'text' || f.code === 'yaml') continue;
      const li = new U.LineIndex(text);
      const push = (names, idx, kind) => names.forEach((n) => refs.push({ name: n, item: it.key, field: f.name, line: li.pos(idx).line, kind }));
      let m;
      const rp = /"path"\s*:\s*"([^"]+)"/g;
      while ((m = rp.exec(text))) push(segs(m[1], '/'), m.index, 'JSONPatch');
      const rg = /\b(getvar|setvar|getMessageVar|getLocalVar|setLocalVar|_\.get|_\.set|_\.has|_\.update)\s*\(\s*(?:[\w.$]+\s*,\s*)?(['"`])([^'"`]+)\2/g;
      while ((m = rg.exec(text))) push(segs(m[3].replace(/^stat_data\./, ''), '.'), m.index, m[1]);
      const rb = /\[\s*(['"])([^'"\]\n]{1,60})\1\s*\]/g;
      while ((m = rb.exec(text))) push([m[2]], m.index, '[...]');
    }
  }
  return refs.filter((r) => /[^\x00-\x7f]/.test(r.name) && !/\d/.test(r.name) && r.name !== '-' && !U.HAS_HANZI.test(r.name));
}

// ---------- chính ----------
async function analyze(rawCard, transCard, opts = {}) {
  const ctx = { decoded: {}, syntaxJobs: [] };
  const C = new Collector();
  const emit = (i) => C.add(i);

  const rawItems = extractZones(rawCard, opts);
  const transItems = extractZones(transCard, opts);
  const rawMap = new Map(rawItems.map((i) => [i.key, i]));
  const transMap = new Map(transItems.map((i) => [i.key, i]));

  // ghép cặp
  const items = [];
  for (const t of transItems) {
    const r = rawMap.get(t.key);
    const inScope = t.inScope || (r && r.inScope);
    const it = { key: t.key, zone: t.zone, label: t.label, rawLabel: r ? r.label : null, comment: t.comment, inScope, isInitvar: t.isInitvar || (r && r.isInitvar), enabled: t.enabled, status: r ? 'paired' : 'extra', fields: [] };
    for (const f of t.fields) {
      const rf = r ? r.fields.find((x) => x.name === f.name) : null;
      it.fields.push({ name: f.name, path: f.path, rawPath: rf ? rf.path : null, code: f.code, raw: rf ? rf.text : null, trans: f.text, lenRaw: rf ? rf.text.length : 0, lenTrans: f.text.length });
    }
    const mainF = it.fields.find((f) => f.name === 'content') || it.fields[0] || {};
    it.raw = mainF.raw;
    it.trans = mainF.trans;
    items.push(it);
    if (!r && inScope && t.zone !== 'greeting') emit({ item: t.key, rule: 'extra_item', sev: 'info', msg: 'Mục này không có trong RAW (khớp theo id).' });
  }
  for (const r of rawItems) {
    if (transMap.has(r.key)) continue;
    if (!r.inScope) continue;
    if (r.zone === 'greeting') continue;
    items.push({ key: r.key, zone: r.zone, label: r.label, rawLabel: r.label, inScope: true, status: 'missing', fields: r.fields.map((f) => ({ name: f.name, path: null, rawPath: f.path, code: f.code, raw: f.text, trans: '', lenRaw: f.text.length, lenTrans: 0 })) });
    emit({ item: r.key, rule: 'missing_item', sev: 'error', msg: `RAW có “${r.label}” nhưng DỊCH không có (khớp theo id).` });
  }
  // greeting thiếu
  for (const r of rawItems.filter((x) => x.zone === 'greeting' && x.inScope && !transMap.has(x.key))) {
    emit({ item: r.key, rule: 'missing_item', sev: 'error', msg: `RAW có ${r.label} chứa khối kỹ thuật nhưng DỊCH không có.` });
  }

  // từng trường
  for (const it of items) {
    if (!it.inScope || it.status === 'missing') continue;
    for (const f of it.fields) await analyzeField(ctx, it, f, f.raw, f.trans, emit);
  }
  // cú pháp (song song)
  await pool(ctx.syntaxJobs, 6);

  // ----- bảng thuật ngữ -----
  const pairsByField = [];
  const alignFail = [];
  for (const it of items) {
    if (!it.inScope || it.status !== 'paired') continue;
    for (const f of it.fields) {
      if (!f.raw || !f.trans || f.code === 'text' || f.code === 'regex') continue;
      const tli = new U.LineIndex(f.trans);
      const lit = (text) => literalsFor(f, text).filter((l) => l.value.length < 300);
      const rl = lit(f.raw), tl = lit(f.trans).map((l) => ({ ...l, line: tli.pos(l.start || 0).line }));
      const al = alignLists(rl, tl);
      if (!al) { alignFail.push({ it, f, rl: rl.length, tl: tl.length }); continue; }
      pairsByField.push({ pairs: al.pairs, loc: { item: it.key, field: f.name } });
      if (f.code === 'js') {
        const ri = skeleton(f.raw).ids, ti = skeleton(f.trans).ids.map((l) => ({ ...l, line: tli.pos(l.start).line }));
        if (ri.length && ri.length === ti.length) pairsByField.push({ pairs: ri.map((x, k) => [x, ti[k]]), loc: { item: it.key, field: f.name } });
      }
      const rp = jsonPatchPaths(f.raw), tp = jsonPatchPaths(f.trans).map((l) => ({ ...l, line: tli.pos(l.start).line }));
      if (rp.length && rp.length === tp.length) pairsByField.push({ pairs: rp.map((x, k) => [x, tp[k]]), loc: { item: it.key, field: f.name } });
    }
  }
  for (const a of alignFail) emit({ item: a.it.key, field: a.f.name, rule: 'align_fail', sev: 'info', msg: `Quá nhiều chuỗi để căn (RAW ${a.rl} / DỊCH ${a.tl}), bỏ qua đối chiếu thuật ngữ cho trường này.` });
  const glossary = buildGlossary(pairsByField);
  for (const g of glossary) {
    if (!g.conflict) continue;
    const top = g.variants.slice(0, 6).map((v) => `“${v.vi}” ×${v.count}`).join(' | ');
    const loc = g.variants[1].locs[0] || g.variants[0].locs[0];
    emit({ item: loc.item, field: loc.field, line: loc.line, rule: 'glossary_conflict', sev: g.keyCtx ? 'error' : 'warn', term: g.zh, msg: `“${g.zh}” → ${top}`, global: true });
  }

  // ----- tham chiếu biến -----
  const knownT = collectKnownVars(items, 'trans');
  if (knownT.size) {
    const refs = collectVarRefs(items, 'trans');
    const knownArr = [...knownT];
    const agg = new Map();
    for (const r of refs) {
      if (knownT.has(r.name)) continue;
      if (!agg.has(r.name)) agg.set(r.name, []);
      agg.get(r.name).push(r);
    }
    for (const [name, rs] of agg) {
      const sug = U.nearest(name, knownArr, 0.34);
      const strong = sug && rs.some((r) => r.kind !== '[...]');
      emit({ item: rs[0].item, field: rs[0].field, line: rs[0].line, rule: 'unknown_var', sev: sug ? (strong ? 'error' : 'warn') : 'info', msg: `“${name}” (${rs.length} lần, ${[...new Set(rs.map((r) => r.kind))].join(', ')}) không có trong initvar/schema${sug ? ` → có phải “${sug}”?` : ''}`, global: true, suggestion: sug });
    }
  }

  // ----- getwi -----
  const transComments = new Set(transItems.filter((i) => i.zone === 'worldbook').map((i) => i.comment));
  const rawComments = new Set(rawItems.filter((i) => i.zone === 'worldbook').map((i) => i.comment));
  const getwiRe = /getwi\s*\(\s*(?:(?:null|undefined|[\w.$]+|(['"`])[^'"`]*\1)\s*,\s*)?(['"`])([^'"`]+)\2/g;
  for (const it of items) {
    if (!it.inScope) continue;
    for (const f of it.fields) {
      if (!f.trans || !/getwi/.test(f.trans)) continue;
      const li = new U.LineIndex(f.trans);
      const rawTargets = f.raw ? [...f.raw.matchAll(getwiRe)].map((m) => m[3]) : [];
      let m, k = 0;
      getwiRe.lastIndex = 0;
      while ((m = getwiRe.exec(f.trans))) {
        const name = m[3];
        const rawName = rawTargets[k++];
        if (transComments.has(name)) continue;
        const rawOk = rawName ? rawComments.has(rawName) : true;
        const sug = U.nearest(name, [...transComments], 0.3);
        emit({ item: it.key, field: f.name, line: li.pos(m.index).line, rule: 'getwi_missing', sev: rawOk ? 'error' : 'info', snippet: U.snippetAt(f.trans, m.index, m[0].length), msg: `getwi → “${name}” không khớp comment nào${sug ? ` (gần nhất: “${sug}”)` : ''}${rawOk ? '' : ' — RAW cũng không khớp'}` });
      }
    }
  }

  // ----- findRegex & đánh dấu -----
  const rxT = items.filter((i) => i.zone === 'regex').map((i) => ({ it: i, f: i.fields.find((f) => f.name === 'findRegex') }));
  for (const { it, f } of rxT) {
    if (f && f.raw != null && f.raw !== f.trans && !U.HAS_CJK.test(f.raw)) emit({ item: it.key, field: 'findRegex', rule: 'findregex_changed', sev: 'warn', msg: `RAW: ${f.raw.slice(0, 150)}  ⇢  DỊCH: ${f.trans.slice(0, 150)}` });
  }
  const compiled = (side) => rxT.map(({ it, f }) => ({ it, re: f && U.parseRegexString(f[side]) })).filter((x) => x.re);
  const rxRaw = compiled('raw'), rxTrans = compiled('trans');
  for (const it of items) {
    if (!it.inScope || it.status !== 'paired' || !(it.zone === 'greeting' || it.zone === 'worldbook')) continue;
    const f = it.fields[0];
    if (!f.raw || !f.trans || f.trans.length > 300000) continue;
    for (let k = 0; k < rxRaw.length; k++) {
      const rr = rxRaw[k];
      const tr = rxTrans.find((x) => x.it.key === rr.it.key);
      const cnt = (re, s) => { re.lastIndex = 0; let n = 0; while (re.exec(s) && n < 1000) { n++; if (!re.global) break; } return n; };
      const a = cnt(rr.re, f.raw);
      if (!a) continue;
      const b = tr ? cnt(tr.re, f.trans) : 0;
      if (b < a) emit({ item: it.key, field: f.name, rule: 'marker_regex', sev: 'error', msg: `Regex “${rr.it.label}” khớp ${a} lần trong RAW nhưng chỉ ${b} lần trong DỊCH → đánh dấu bị dịch/đổi?` });
    }
  }

  // ----- data.* đồng bộ -----
  const dataSync = [];
  const d = transCard.data || {};
  if (typeof transCard.first_mes === 'string' && typeof d.first_mes === 'string' && transCard.first_mes !== d.first_mes) dataSync.push('first_mes');
  if (Array.isArray(transCard.alternate_greetings) && Array.isArray(d.alternate_greetings)) {
    if (transCard.alternate_greetings.length !== d.alternate_greetings.length) dataSync.push(`alternate_greetings (số lượng ${transCard.alternate_greetings.length} ≠ ${d.alternate_greetings.length})`);
    else transCard.alternate_greetings.forEach((g, i) => { if (g !== d.alternate_greetings[i]) dataSync.push(`alternate_greetings[${i}]`); });
  }
  for (const x of dataSync) emit({ item: 'greet:' + x.replace(/ .*/, ''), rule: 'data_sync', sev: 'error', msg: `${x} khác data.${x.replace(/ .*/, '')}`, fixable: true, global: true });

  // ----- tên thẻ -----
  const rawName = rawCard.data?.name || rawCard.name || '';
  const transName = transCard.data?.name || transCard.name || '';
  for (const it of items) {
    if (!it.inScope || !(it.zone === 'script' || it.zone === 'regex')) continue;
    for (const f of it.fields) {
      if (!f.trans || f.code === 'text') continue;
      const re = /\b(cardName|CARD_NAME|MY_NAME|myName|charName|characterName|CHAR_NAME)\s*[:=]\s*(['"`])([^'"`]+)\2/g;
      let m;
      while ((m = re.exec(f.trans))) {
        if (transName === m[3] || transName.startsWith(m[3])) continue;
        emit({ item: it.key, field: f.name, line: new U.LineIndex(f.trans).pos(m.index).line, rule: 'card_name', sev: 'warn', msg: `${m[1]} = “${m[3]}” nhưng tên thẻ DỊCH là “${transName}”` });
      }
      if (rawName && U.HAS_HANZI.test(rawName) && f.trans.includes(rawName)) {
        const at = f.trans.indexOf(rawName);
        emit({ item: it.key, field: f.name, line: new U.LineIndex(f.trans).pos(at).line, rule: 'card_name', sev: 'warn', snippet: U.snippetAt(f.trans, at, rawName.length), msg: `Còn tên thẻ gốc “${rawName}” trong code` });
      }
    }
  }

  const issues = C.finalize();

  // ----- tổng hợp theo item -----
  const byItem = new Map();
  for (const i of issues) {
    if (!byItem.has(i.item)) byItem.set(i.item, { error: 0, warn: 0, info: 0 });
    byItem.get(i.item)[i.sev]++;
  }
  const itemsOut = items.map((it) => ({
    key: it.key, zone: it.zone, label: it.label, rawLabel: it.rawLabel, inScope: it.inScope, status: it.status, isInitvar: it.isInitvar, enabled: it.enabled,
    counts: byItem.get(it.key) || { error: 0, warn: 0, info: 0 },
    fields: it.fields.map((f) => ({ name: f.name, path: f.path, rawPath: f.rawPath, code: f.code, lenRaw: f.lenRaw, lenTrans: f.lenTrans })),
  }));

  const sum = (cats, sev) => issues.filter((i) => cats.includes(RULES[i.rule]?.cat) && (!sev || sev.includes(i.sev))).length;
  const checklist = [
    { id: 'scope', title: 'SKIP ĐÚNG PHẠM VI', pass: true, detail: 'Tool chỉ đọc/sửa trong 4 vùng lõi; keys, secondary_keys, button(s), mục văn xuôi và greeting không có khối kỹ thuật được giữ nguyên.' },
    { id: 'cjk', title: 'SẠCH HÁN TỰ 100% TRONG PHẠM VI', pass: sum(['cjk'], ['error']) === 0, detail: `${issues.filter((i) => i.rule === 'cjk').length} cụm Hán tự trực tiếp · ${issues.filter((i) => i.rule === 'cjk_b64').length} trong Base64 · ${issues.filter((i) => i.rule === 'cjk_escape').length} \\uXXXX` },
    { id: 'sync', title: 'ĐỒNG BỘ BIẾN & THAM CHIẾU', pass: sum(['sync'], ['error']) === 0, detail: `${issues.filter((i) => i.rule === 'glossary_conflict').length} thuật ngữ dịch không nhất quán · ${issues.filter((i) => i.rule === 'unknown_var').length} tên biến lạ · ${issues.filter((i) => i.rule === 'getwi_missing').length} getwi lỗi · ${issues.filter((i) => i.rule === 'marker_regex').length} đánh dấu lệch regex · ${issues.filter((i) => i.rule === 'data_sync').length} lệch data.*` },
    { id: 'syntax', title: 'KIỂM TRA CÚ PHÁP CODE', pass: sum(['syntax'], ['error']) === 0 && sum(['struct'], ['error']) === 0, detail: `${issues.filter((i) => i.rule === 'syntax').length} lỗi cú pháp · ${issues.filter((i) => i.rule === 'skeleton').length} khung code lệch · ${issues.filter((i) => i.rule === 'url_lost' || i.rule === 'mdlink').length} lỗi URL` },
    { id: 'ui', title: 'GIAO DIỆN & FONT TIẾNG VIỆT', pass: sum(['ui'], ['error', 'warn']) === 0, detail: `${issues.filter((i) => i.rule === 'font').length} font cấm · ${issues.filter((i) => i.rule === 'ellipsis').length} cắt chữ · ${issues.filter((i) => i.rule === 'overflow').length} overflow:hidden` },
  ];

  return {
    meta: {
      rawName, transName,
      zones: ['worldbook', 'greeting', 'script', 'regex'].map((z) => ({ zone: z, total: items.filter((i) => i.zone === z).length, inScope: items.filter((i) => i.zone === z && i.inScope).length })),
      totals: { error: issues.filter((i) => i.sev === 'error').length, warn: issues.filter((i) => i.sev === 'warn').length, info: issues.filter((i) => i.sev === 'info').length },
    },
    rules: RULES,
    checklist,
    items: itemsOut,
    issues,
    glossary: glossary.slice(0, 5000),
    decoded: ctx.decoded,
  };
}

module.exports = { analyze, RULES, technicalRanges, scriptBlocks };
