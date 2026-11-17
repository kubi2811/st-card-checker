'use strict';
// Sửa tự động các lỗi AN TOÀN trên File DỊCH (chỉ trong 4 vùng lõi). Không bao giờ đụng keys/secondary_keys/button(s).
const U = require('./util');
const { extractZones, setAt } = require('./extract');
const { fixFontsInText } = require('./fonts');
const { technicalRanges, scriptBlocks } = require('./analyzer');

const PUNCT_SAFE = {
  '，': ', ', '。': '. ', '、': ', ', '：': ': ', '；': '; ', '！': '! ', '　': ' ',
  '《': '“', '》': '”', '「': '“', '」': '”', '『': '‘', '』': '’', '〈': '‹', '〉': '›',
  '～': '~', '＝': '=', '％': '%', '＃': '#', '＆': '&', '＠': '@', '＂': '"', '＇': '\'',
};
// ký tự đặc biệt trong regex → chỉ thay ngoài regex literal
const PUNCT_REGEXY = { '（': ' (', '）': ') ', '【': '[', '】': ']', '｜': '|', '？': '? ', '＋': '+', '－': '-', '＊': '*', '．': '.', '／': '/', '［': '[', '］': ']', '｛': '{', '｝': '}', '＜': '<', '＞': '>' };

function regexRangesFor(code, text) {
  // trả về các khoảng [s,e] là regex literal hoặc dòng có RegExp(
  const ranges = [];
  const addJs = (js, off) => {
    const lits = U.extractJsLiterals(js);
    for (const [s, e] of lits.regex) ranges.push([s + off, e + off]);
  };
  if (code === 'js') addJs(text, 0);
  else if (code === 'html') scriptBlocks(text).forEach((b) => addJs(b.code, b.start));
  else if (code === 'ejs') U.ejsBlocks(text).forEach((b) => addJs(b.code, b.start));
  const re = /^.*RegExp\(.*$/gm;
  let m;
  while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
const inR = (ranges, i) => ranges.some(([s, e]) => i >= s && i < e);

function fixPunct(text, code, scope) {
  const rr = regexRangesFor(code, text);
  let n = 0;
  const out = text.replace(/[，。、：；！　《》「」『』〈〉～＝％＃＆＠＂＇（）【】｜？＋－＊．／［］｛｝＜＞]/g, (ch, idx) => {
    if (scope && !scope.some(([s, e]) => idx >= s && idx < e)) return ch;
    if (PUNCT_SAFE[ch] !== undefined) { n++; return PUNCT_SAFE[ch]; }
    if (PUNCT_REGEXY[ch] !== undefined) {
      if (inR(rr, idx)) return ch;
      n++; return PUNCT_REGEXY[ch];
    }
    return ch;
  });
  return { text: out, changed: n };
}

function fixMdLinks(text) {
  let n = 0;
  const out = text.replace(/\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g, (all, a) => { n++; return a; });
  return { text: out, changed: n };
}

function fixEllipsis(text) {
  let n = 0;
  let out = text.replace(/text-overflow\s*:\s*ellipsis/gi, () => { n++; return 'text-overflow:clip'; });
  out = out.replace(/(-webkit-line-clamp\s*:\s*)\d+/gi, (a, h) => { n++; return h + 'unset'; });
  out = out.replace(/(textOverflow\s*[:=]\s*)(['"])ellipsis\2/g, (a, h, q) => { n++; return h + q + 'clip' + q; });
  return { text: out, changed: n };
}

// Các khoảng "an toàn để thay chữ": bên trong chuỗi/comment của code, hoặc phần văn bản ngoài code.
// (Không bao giờ thay định danh JS không có nháy như  result.兵力 = …  vì bản dịch có dấu cách sẽ làm hỏng cú pháp.)
function textSafeRanges(code, text) {
  const jsSafe = (js, off) => {
    const t = U.extractJsLiterals(js);
    return [...t.map((l) => [l.start + off, l.end + off]), ...t.comments.map(([s, e]) => [s + off, e + off])];
  };
  if (code === 'js') return jsSafe(text, 0);
  if (code === 'yaml') return [[0, text.length]];
  const blocks = code === 'html'
    ? scriptBlocks(text).map((b) => ({ start: b.start, end: b.start + b.code.length, code: b.code }))
    : U.ejsBlocks(text).map((b) => ({ start: b.start, end: b.start + b.code.length, code: b.code }));
  const out = [];
  let last = 0;
  for (const b of blocks) { out.push([last, b.start]); out.push(...jsSafe(b.code, b.start)); last = b.end; }
  out.push([last, text.length]);
  return out;
}
const IDENT = /[A-Za-z0-9_$À-ỹ]/;

function fixGlossary(text, glossaryMap, scope, code) {
  if (!glossaryMap || !glossaryMap.size) return { text, changed: 0 };
  let n = 0;
  const safe = textSafeRanges(code, text).sort((a, b) => a[0] - b[0]);
  const isSafe = (s, e) => {
    let lo = 0, hi = safe.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (safe[m][1] < e) lo = m + 1; else hi = m - 1; }
    for (let k = Math.max(0, lo - 2); k < Math.min(safe.length, lo + 3); k++) if (s >= safe[k][0] && e <= safe[k][1]) return true;
    return false;
  };
  const out = text.replace(/[㐀-䶿一-丧丩-鿿]+/g, (run, idx) => {
    if (scope && !scope.some(([s, e]) => idx >= s && idx < e)) return run;
    if (!isSafe(idx, idx + run.length)) return run;
    // chữ dính liền định danh / sau dấu chấm → không thay
    if (text[idx - 1] === '.' || IDENT.test(text[idx - 1] || '') || IDENT.test(text[idx + run.length] || '')) return run;
    const vi = glossaryMap.get(run);
    if (!vi) return run;
    n++; return vi;
  });
  return { text: out, changed: n };
}

// Áp dụng hàm sửa cho text + các khối Base64 văn bản bên trong
function applyDeep(text, fn) {
  let total = 0;
  let r = fn(text, null);
  total += r.changed;
  let t = r.text;
  const blocks = U.findTextBase64(t);
  if (blocks.length) {
    let out = '', last = 0;
    for (const b of blocks) {
      const inner = fn(b.decoded, /<\w+[\s>]/.test(b.decoded) ? 'html' : 'js');
      out += t.slice(last, b.start);
      if (inner.changed) { out += U.encodeBase64Like(inner.text, b); total += inner.changed; }
      else out += b.b64;
      last = b.start + b.length;
    }
    out += t.slice(last);
    t = out;
  }
  return { text: t, changed: total };
}

/**
 * opts: { fonts, mdlink, ellipsis, dataSync, punct, glossary, glossaryMap: Map(zh->vi) }
 */
function applyFixes(card, opts = {}) {
  const log = [];
  const items = extractZones(card, opts);
  for (const it of items) {
    if (!it.inScope) continue;
    for (const f of it.fields) {
      if (f.code === 'text' || f.code === 'regex') continue; // tên/findRegex: không tự động sửa
      let text = f.text;
      const scope = it.zone === 'greeting' ? technicalRanges(text) : null;
      if (it.zone === 'greeting' && !scope.length) continue;
      const steps = [];
      if (opts.mdlink && f.code !== 'yaml') steps.push(['URL Markdown', (t) => fixMdLinks(t)]);
      if (opts.fonts && it.zone !== 'greeting') steps.push(['Font', (t) => fixFontsInText(t)]);
      if (opts.ellipsis && it.zone !== 'greeting') steps.push(['Ellipsis', (t) => fixEllipsis(t)]);
      if (opts.glossary) steps.push(['Thuật ngữ', (t, code) => fixGlossary(t, opts.glossaryMap, it.zone === 'greeting' ? technicalRanges(t) : null, code || f.code)]);
      if (opts.punct) steps.push(['Dấu câu CJK', (t, code) => fixPunct(t, code || f.code, it.zone === 'greeting' ? technicalRanges(t) : null)]);
      for (const [name, fn] of steps) {
        const r = it.zone === 'greeting' ? fn(text) : applyDeep(text, fn);
        if (r.changed) { log.push({ item: it.key, label: it.label, field: f.name, fix: name, count: r.changed }); text = r.text; }
      }
      if (text !== f.text) setAt(card, f.path, text);
    }
  }
  if (opts.dataSync && card.data) {
    if (typeof card.first_mes === 'string' && card.first_mes !== card.data.first_mes) {
      card.data.first_mes = card.first_mes;
      log.push({ item: 'greet:first_mes', label: 'first_mes', field: 'data.first_mes', fix: 'Đồng bộ gốc → data.*', count: 1 });
    }
    if (Array.isArray(card.alternate_greetings) && JSON.stringify(card.alternate_greetings) !== JSON.stringify(card.data.alternate_greetings)) {
      card.data.alternate_greetings = card.alternate_greetings.slice();
      log.push({ item: 'greet:alternate_greetings', label: 'alternate_greetings', field: 'data.alternate_greetings', fix: 'Đồng bộ gốc → data.*', count: card.alternate_greetings.length });
    }
  }
  return { card, log };
}

function detectIndent(text) {
  const m = text.match(/^\{\r?\n([ \t]+)"/);
  if (m) return m[1];
  return /^\{\r?\n/.test(text) ? '  ' : 0;
}

module.exports = { applyFixes, detectIndent, fixPunct };
