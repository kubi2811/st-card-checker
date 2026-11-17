'use strict';
// Quy chuẩn font tiếng Việt: phát hiện & thay font không hỗ trợ đủ dấu tiếng Việt.

const SERIF_BAD = [
  'Noto Serif CJK SC', 'Noto Serif CJK TC', 'Noto Serif CJK', 'Noto Serif SC', 'Noto Serif TC', 'Noto Serif JP',
  'Source Han Serif SC', 'Source Han Serif CN', 'Source Han Serif TC', 'Source Han Serif',
  'Songti SC', 'Songti TC', 'Songti', 'STSong', 'STZhongsong', 'SimSun', 'NSimSun', '宋体', '新宋体',
  'KaiTi', 'STKaiti', 'Kaiti SC', 'Kaiti', '楷体', 'FangSong', 'STFangsong', '仿宋',
  'Hiragino Mincho ProN', 'Hiragino Mincho Pro', 'LXGW WenKai', '霞鹜文楷',
  'Georgia', 'Palatino Linotype', 'Palatino', 'Book Antiqua', 'Baskerville', 'Didot',
];
const SANS_BAD = [
  'PingFang SC', 'PingFang TC', 'PingFang HK', 'PingFang', '苹方',
  'Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'Microsoft JhengHei', 'SimHei', '黑体',
  'Heiti SC', 'Heiti TC', 'STHeiti', 'Hiragino Sans GB', 'Hiragino Sans',
  'Noto Sans CJK SC', 'Noto Sans CJK TC', 'Noto Sans CJK', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP',
  'Source Han Sans SC', 'Source Han Sans CN', 'Source Han Sans TC', 'Source Han Sans',
  'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'Droid Sans Fallback', 'HarmonyOS Sans SC', 'MiSans',
];
const BAD = [...SERIF_BAD, ...SANS_BAD].sort((a, b) => b.length - a.length);
const SERIF_SET = new Set(SERIF_BAD.map((s) => s.toLowerCase()));

const STACK = {
  serif: ['Noto Serif', 'Times New Roman', 'serif'],
  sans: ['Inter', 'Segoe UI', 'Roboto', 'Noto Sans', 'system-ui', '-apple-system', 'sans-serif'],
  mono: ['JetBrains Mono', 'Consolas', 'Noto Sans Mono', 'Courier New', 'monospace'],
};
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', '-apple-system', 'cursive', 'fantasy', 'inherit', 'initial', 'unset', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'blinkmacsystemfont']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BAD_RE = () => new RegExp('(^|[\\s"\'`,:\\\\])(' + BAD.map(esc).join('|') + ')(?=$|[\\s"\'`,;}\\\\!)])', 'gi');
const FONT_CTX = /(font-family|font\s*:|fontFamily|--[\w-]*(?:font|serif|sans|mono|family)[\w-]*\s*:|face\s*=)/i;

// Tìm font cấm (chỉ khi nằm trong ngữ cảnh khai báo font)
function findBadFonts(text) {
  const out = [];
  const re = BAD_RE();
  let m;
  while ((m = re.exec(text))) {
    const idx = m.index + m[1].length;
    const back = text.slice(Math.max(0, idx - 300), idx);
    const cut = Math.max(back.lastIndexOf(';'), back.lastIndexOf('{'), back.lastIndexOf('}'), back.lastIndexOf('\n'));
    const ctx = back.slice(cut + 1);
    if (!FONT_CTX.test(ctx)) continue;
    out.push({ index: idx, font: m[2] });
  }
  return out;
}

function splitFamilies(v) {
  const parts = [];
  let cur = '', q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) { cur += c; if (c === q && v[i - 1] !== '\\') q = null; else if (c === q) q = null; continue; }
    if (c === '"' || c === '\'') { q = c; cur += c; continue; }
    if (c === ',') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
const unq = (s) => s.trim().replace(/^\\?["']|\\?["']$/g, '').trim();

// Sửa một chuỗi giá trị font-family. Trả về chuỗi mới (hoặc chính nó nếu không đổi).
function fixFamilyValue(value, isShorthand) {
  let prefix = '';
  let v = value;
  if (isShorthand) {
    const m = v.match(/^(.*?\d[\w.%]*(?:\s*\/\s*[\w.%]+)?\s+)(.*)$/s);
    if (!m) return value;
    prefix = m[1]; v = m[2];
  }
  const lead = v.match(/^\s*/)[0];
  const trail = v.match(/\s*(!important)?\s*$/)[0];
  const core = v.slice(lead.length, v.length - trail.length);
  const items = splitFamilies(core);
  let removed = [], firstRemovedAt = -1;
  const kept = [];
  items.forEach((it) => {
    const name = unq(it).toLowerCase();
    if (BAD.some((b) => b.toLowerCase() === name)) {
      removed.push(name);
      if (firstRemovedAt < 0) firstRemovedAt = kept.length;
    } else kept.push(it);
  });
  if (!removed.length) return value;
  const names = kept.map((k) => unq(k).toLowerCase());
  let cat = 'sans';
  if (names.includes('monospace') || names.some((n) => /mono|consolas|courier/.test(n))) cat = 'mono';
  else if (removed.some((r) => SERIF_SET.has(r)) || names.includes('serif')) cat = 'serif';
  // ký tự trích dẫn tái sử dụng
  const qm = core.match(/\\?["']/);
  const Q = qm ? qm[0] : '"';
  const quote = (n) => (/^[\w-]+$/.test(n) ? n : Q + n + Q);
  const insert = STACK[cat].filter((s) => !names.includes(s.toLowerCase())).map(quote);
  // bỏ generic trùng ở cuối: giữ generic hiện có, chỉ chèn stack (trừ generic nếu đã có generic)
  const hasGeneric = names.some((n) => GENERIC.has(n));
  const ins = hasGeneric ? insert.filter((s) => !GENERIC.has(unq(s).toLowerCase())) : insert;
  const out = kept.map((k) => k.trim());
  out.splice(firstRemovedAt, 0, ...ins);
  return prefix + lead + out.filter(Boolean).join(', ') + trail;
}

// Cắt giá trị tại dấu nháy không cân bằng (khi CSS nằm trong chuỗi JS / thuộc tính HTML)
function splitUnbalanced(val) {
  let cut = val.length;
  for (const q of ['"', '\'', '`']) {
    const n = val.split(q).length - 1;
    if (n % 2 === 1) cut = Math.min(cut, val.lastIndexOf(q) - (val[val.lastIndexOf(q) - 1] === '\\' ? 1 : 0));
  }
  return [val.slice(0, cut), val.slice(cut)];
}

// Sửa toàn bộ text: khai báo CSS, biến CSS, thuộc tính JS fontFamily
function fixFontsInText(text) {
  let changed = 0;
  // CSS: font-family: ... ; biến --*-font: ...
  text = text.replace(/((?:font-family|--[\w-]*(?:font|serif|sans|mono|family)[\w-]*)\s*:\s*)([^;{}\n<>]+)/gi, (all, head, raw) => {
    const [val, rest] = splitUnbalanced(raw);
    const nv = fixFamilyValue(val, false);
    if (nv !== val) changed++;
    return head + nv + rest;
  });
  // CSS shorthand: font: 14px "X", serif
  text = text.replace(/((?:^|[\s;{"'])font\s*:\s*)([^;{}\n<>]+)/gi, (all, head, raw) => {
    const [val, rest] = splitUnbalanced(raw);
    const nv = fixFamilyValue(val, true);
    if (nv !== val) changed++;
    return head + nv + rest;
  });
  // Thuộc tính HTML/SVG: font-family="..." / face="..."
  text = text.replace(/((?:font-family|face)\s*=\s*)(\\?["'])(.*?)\2/gi, (all, head, q, val) => {
    if (/[;:{}]/.test(val)) return all;
    const nv = fixFamilyValue(val.replace(/"/g, "'"), false).replace(/"/g, "'");
    if (nv === val) return all;
    changed++;
    return head + q + nv + q;
  });
  // JS: fontFamily: '...' / fontFamily = "..."
  text = text.replace(/(fontFamily\s*[:=]\s*)(['"`])((?:\\.|(?!\2).)*)\2/g, (all, head, q, val) => {
    const nv = fixFamilyValue(val.replace(new RegExp(q, 'g'), q === '"' ? '\'' : '"'), false);
    if (nv === val) return all;
    changed++;
    return head + q + nv.split(q).join('\\' + q) + q;
  });
  return { text, changed };
}

module.exports = { findBadFonts, fixFontsInText, fixFamilyValue, STACK };
