'use strict';
// Quy trình AI: phân tích tất định → chỉ gửi những đoạn có lỗi cho AI → kiểm tra lại từng đoạn → ghép vào thẻ.
const U = require('../util');
const { extractZones, setAt } = require('../extract');
const { analyze, technicalRanges, scriptBlocks } = require('../analyzer');
const { applyFixes } = require('../fixer');
const { checkSyntax } = require('../jscheck');
const client = require('./client');
const P = require('./prompts');
const cache = require('./cache');

const REBUILD_RULES = new Set(['skeleton', 'syntax', 'empty_field']);
const NOTE_RULES = new Set(['getwi_missing', 'card_name', 'bracket_path', 'marker_regex']);
const HANZI_G = /[㐀-䶿一-丧丩-鿿豈-﫿]+/g;
const cjkCount = (s) => (s.match(new RegExp(U.CJK_RE.source, 'g')) || []).length;

// ---------- chia đoạn ----------
function segmentize(text, maxLen) {
  const segs = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    let p = 0;
    while (p < line.length) {
      let e = line.length;
      if (e - p > maxLen) {
        e = p + maxLen;
        const win = line.slice(p + Math.floor(maxLen * 0.5), e);
        const cut = Math.max(win.lastIndexOf('>'), win.lastIndexOf(';'), win.lastIndexOf('}'), win.lastIndexOf(','), win.lastIndexOf(' '));
        if (cut >= 0) e = p + Math.floor(maxLen * 0.5) + cut + 1;
        // không cắt giữa cụm Hán tự / cặp surrogate
        while (e > p + 1 && (U.HAS_CJK.test(line[e - 1] || '') && U.HAS_CJK.test(line[e] || '') || /[\uD800-\uDBFF]/.test(line[e - 1]))) e--;
      }
      const s = pos + p, raw = line.slice(p, e);
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.slice(lead.length).match(/\s*$/)[0];
      const core = raw.slice(lead.length, raw.length - trail.length);
      if (core) segs.push({ start: s, end: pos + e, lead, trail, core });
      p = e;
    }
    pos += line.length + 1;
  }
  return segs;
}

// Chữ ký cấu trúc: các ký tự cú pháp phải được giữ nguyên khi dịch
const FW = { '（': '(', '）': ')', '【': '[', '】': ']', '［': '[', '］': ']', '｛': '{', '｝': '}', '；': ';', '＝': '=', '＄': '$', '：': ':' };
function sig(s) {
  return s
    .replace(/[（）【】［］｛｝；＝＄：]/g, (c) => FW[c])
    .replace(/\[\s*(['"`])[^'"`\n\]]*\1\s*\]/g, '')
    .replace(/(['"])[^'"\n]*\1(?=\s*:)/g, '')
    .replace(/[^{}[\]()<>;=`"'\\$]/g, '');
}

// Tự vá lỗi cú pháp hay gặp trong một dòng đã dịch (chỉ giữ nếu node --check xác nhận tốt hơn):
//  • khóa object trần bị dịch thành nhiều chữ  { Lựa chọn: … }  →  { 'Lựa chọn': … }
//  • mất dấu phẩy/chấm phẩy/ngoặc ở đầu/cuối dòng so với RAW
const IDENT_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
function quoteBareKeys(t) {
  let out = '', i = 0, q = null, keyPos = true;
  while (i < t.length) {
    const c = t[i];
    if (q) { out += c; if (c === '\\') { out += t[i + 1] || ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === '\'' || c === '`') { q = c; keyPos = false; out += c; i++; continue; }
    if (keyPos && !/\s/.test(c)) {
      const m = t.slice(i).match(/^([^:'"`{}[\](),;=?\n]+?)\s*:(?!:)/);
      if (m && /\S\s+\S/.test(m[1]) && !/^(case|default)\b/.test(m[1])) {
        const k = m[1].trim();
        if (!IDENT_RE.test(k)) { out += '\'' + k.replace(/'/g, '\\\'') + '\''; i += m[1].trimEnd().length; keyPos = false; continue; }
      }
    }
    if (c === '{' || c === ',') keyPos = true; else if (!/\s/.test(c)) keyPos = false;
    out += c; i++;
  }
  return out;
}
function repairSeg(tr, core) {
  let t = quoteBareKeys(tr);
  const re = core.trimEnd().slice(-1), te = t.trimEnd().slice(-1);
  if (',;{[('.includes(re) && te !== re) t = t.trimEnd() + re;
  const rs = core.trimStart()[0], ts = t.trimStart()[0];
  if ('}])'.includes(rs) && ts !== rs) t = rs + ' ' + t.trimStart();
  return t;
}

// So chữ ký cú pháp; riêng “；” (thường là dấu câu trong văn) được phép thành “;” / “,” / “.”
function sigOk(out, core) {
  const a = sig(out), b = sig(core);
  if (a === b) return true;
  const fw = (core.match(/；/g) || []).length;
  if (!fw) return false;
  const strip = (x) => x.replace(/;/g, '');
  const n = (x) => (x.match(/;/g) || []).length;
  const coreSemi = n(sig(core.replace(/；/g, '')));
  return strip(a) === strip(b) && n(a) >= coreSemi && n(a) <= coreSemi + fw;
}

function lineStarts(text) {
  const a = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') a.push(i + 1);
  return a;
}
function lineOf(starts, idx) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= idx) lo = m; else hi = m - 1; }
  return lo + 1;
}

async function firstSyntaxError(text, code) {
  if (code === 'js') { const r = await checkSyntax(text); return r.ok ? null : { line: r.line, message: r.message }; }
  if (code === 'ejs') {
    if (!/<%/.test(text)) return null;
    const r = await checkSyntax(U.ejsToJs(text));
    return r.ok ? null : { line: r.line ? r.line - 1 : null, message: r.message };
  }
  if (code === 'html') {
    const starts = lineStarts(text);
    for (const b of scriptBlocks(text)) {
      const r = await checkSyntax(b.code);
      if (!r.ok) return { line: r.line ? lineOf(starts, b.start) + r.line - 1 : null, message: r.message };
    }
  }
  return null;
}

// Giới hạn số lượt gọi mỗi phút (RPM): giãn đều thời điểm bắt đầu các lượt gọi
class Rate {
  constructor(rpm) { this.gap = rpm > 0 ? 60000 / rpm : 0; this.next = 0; }
  async wait(signal) {
    if (!this.gap || signal?.aborted) return;
    const now = Date.now();
    const t = Math.max(now, this.next);
    this.next = t + this.gap;
    if (t > now) await new Promise((r) => { const h = setTimeout(r, t - now); signal?.addEventListener('abort', () => { clearTimeout(h); r(); }, { once: true }); });
  }
}

// Lỗi không thể tự hết (sai key, sai model, sai URL) → dừng ngay thay vì gửi tiếp hàng trăm lượt
const isFatal = (e) => [400, 401, 403, 404].includes(e.status) && !/quota|rate/i.test(e.message);
function fatalMsg(e) {
  const why = e.status === 401 || e.status === 403 ? 'API key sai hoặc không có quyền' : e.status === 404 ? 'sai URL API hoặc model không tồn tại' : 'yêu cầu bị từ chối (model/tham số không hợp lệ?)';
  return `DỪNG: ${why} — ${e.message.slice(0, 200)}`;
}

class Limiter {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  run(fn) {
    return new Promise((res, rej) => {
      const go = () => { this.active++; fn().then(res, rej).finally(() => { this.active--; const nx = this.q.shift(); if (nx) nx(); }); };
      if (this.active < this.n) go(); else this.q.push(go);
    });
  }
}

// ---------- công việc ----------
class Job {
  constructor(id, input) {
    this.id = id;
    this.input = input;
    this.state = 'running';
    this.phase = 'Chuẩn bị';
    this.log = [];
    this.stats = { batches: 0, batchesDone: 0, segs: 0, segsOk: 0, segsFail: 0, segsReverted: 0, fields: 0, fieldsDone: 0, rebuilt: 0, calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
    this.ac = new AbortController();
    this.result = null;
    this.samples = [];
    this.startedAt = Date.now();
  }
  say(msg, level = 'info', extra) { if (this.log.length > 30000 && level === 'info') return; this.log.push({ t: Date.now(), level, msg, ...(extra || {}) }); }
  cancel() {
    if (this.userCancelled || this.state !== 'running') return;
    this.userCancelled = true;
    this.phase = 'Đang dừng — ghép & lưu phần đã dịch…';
    this.say('Người dùng đã dừng → ghép phần đã dịch xong thành file (phần còn lại giữ nguyên). Chạy lại sau sẽ dùng lại các đoạn đã dịch, không tốn lượt gọi.', 'warn');
    this.ac.abort(new Error('Đã dừng'));
  }
  // dừng hẳn (lỗi nghiêm trọng) — khác với người dùng bấm Dừng (vẫn ghép phần đã có)
  get hardStop() { return this.ac.signal.aborted && !this.userCancelled; }
  get aborted() { return this.ac.signal.aborted; }
  outName() {
    const n = this.input.names || {};
    const mode = this.input.mode;
    const b = String((mode === 'fix' ? n.trans : n.raw) || n.raw || 'the').replace(/\.json$/i, '');
    const d = new Date(this.startedAt);
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return `${b}.${mode === 'fix' ? 'ai-fixed' : 'ai-vi'}${this.userCancelled ? '.dang-do' : ''}.${ts}.json`;
  }
}

async function run(job) {
  const { rawText, mode = 'fix', options = {} } = job.input;
  const passes = options.limitSegs ? 1 : Math.max(1, Math.min(5, Number(options.passes) || 2));
  let transText = job.input.transText;
  for (let pass = 1; pass <= passes; pass++) {
    const pm = mode === 'translate' && pass > 1 ? 'fix' : mode;
    job.pass = pass;
    if (passes > 1) job.say(`===== Vòng ${pass}/${passes} =====`, 'ok');
    const prevErr = job.after ? job.after.error : Infinity;
    await runPass(job, rawText, transText, pm, pass);
    if (job.aborted || !job.result) break;
    transText = job.result;
    if (!job.after || job.after.error === 0) break;
    if (pass > 1 && job.after.error >= prevErr) { job.say('Vòng này không giảm thêm lỗi → dừng.', 'info'); break; }
  }
  if (job.result && !job.fatal) {
    try {
      const f = cache.saveResult(job.outName(), job.result);
      job.savedFile = f;
      job.say(`Đã lưu file: ${f}`, 'ok');
    } catch (e) { job.say('Không lưu được file kết quả: ' + e.message, 'error'); }
  }
}

async function runPass(job, rawText, transText, mode, pass) {
  const { options = {}, ai } = job.input;
  const raw = JSON.parse(rawText.replace(/^﻿/, ''));
  const trans = mode === 'translate' ? null : JSON.parse(transText.replace(/^﻿/, ''));
  const base = JSON.parse(JSON.stringify(mode === 'translate' ? raw : trans));
  const cardName = base.data?.name || base.name || '';
  Object.assign(job.stats, { batches: 0, batchesDone: 0, fields: 0, fieldsDone: 0 });
  const cfg = {
    baseURL: ai.baseURL, apiKey: ai.apiKey, model: ai.model, temperature: ai.temperature ?? 0.2, maxTokens: ai.maxTokens || 0,
    retries: 1000, signal: job.ac.signal,
    onRetry: (e, n, w) => {
      const hint = /quota|billing/i.test(e.message) ? ' — tài khoản đã HẾT QUOTA, hãy đổi tài khoản/key bên provider (tool sẽ tự chạy tiếp)' : (/rate limit/i.test(e.message) ? ' — vượt giới hạn tốc độ, nên giảm RPM / luồng song song' : '');
      job.say(`API lỗi (${e.message.slice(0, 120)})${hint} → thử lại lần ${n} sau ${(w / 1000).toFixed(0)}s`, n > 1 && !hint ? 'warn' : 'error');
    },
  };
  const rpm = ai.rpm == null || ai.rpm === '' ? 0 : Math.max(0, Number(ai.rpm) || 0);
  const rate = job.rate || (job.rate = new Rate(rpm));
  if (pass === 1 && rpm) job.say(`Giới hạn ${rpm} lượt gọi/phút.`);
  const limiter = new Limiter(Math.max(1, Math.min(64, Number(ai.concurrency) || 3)));
  const batchChars = Math.max(500, Number(ai.batchChars) || 12000);
  const maxSegsPerBatch = Math.max(1, Number(ai.batchSegs) || 200);
  const segLen = Math.max(200, Number(ai.segLen) || 900);

  // Prompt bổ sung kiểu SillyTavern (jailbreak, prefill…): Đầu = trước prompt của tool, Cuối = sau cùng
  const extras = (Array.isArray(ai.extraPrompts) ? ai.extraPrompts : []).filter((p) => p && String(p.content || '').trim())
    .map((p) => ({ role: ['system', 'user', 'assistant'].includes(p.role) ? p.role : 'system', pos: p.pos === 'end' ? 'end' : 'start', content: String(p.content).replace(/\{\{char\}\}/gi, cardName) }));
  const withExtras = (messages) => !extras.length ? messages : [
    ...extras.filter((p) => p.pos === 'start').map(({ role, content }) => ({ role, content })),
    ...messages,
    ...extras.filter((p) => p.pos === 'end').map(({ role, content }) => ({ role, content })),
  ];
  if (pass === 1 && extras.length) job.say(`Dùng ${extras.length} prompt bổ sung (${extras.filter((p) => p.pos === 'start').length} đầu, ${extras.filter((p) => p.pos === 'end').length} cuối).`);
  cfg.stream = ai.stream !== false;
  if (pass === 1 && !cfg.stream) job.say('Streaming đang TẮT — nếu trạm cắt phản hồi dài / lỗi 524 thì bật lại.', 'warn');
  const callAI = async (messages) => {
    if (job.aborted) throw new Error('Đã dừng');
    const r = await limiter.run(async () => {
      if (job.aborted) throw new Error('Đã dừng');
      await rate.wait(job.ac.signal);
      return client.chat(cfg, withExtras(messages));
    });
    job.stats.calls++;
    if (r.usage) { job.stats.promptTokens += r.usage.prompt_tokens || 0; job.stats.completionTokens += r.usage.completion_tokens || 0; }
    return r;
  };

  // ---- 1. phân tích tất định ----
  let report = null;
  if (mode === 'fix') {
    job.phase = `Vòng ${pass}: phân tích RAW ↔ DỊCH`;
    job.say('Đang phân tích RAW ↔ DỊCH bằng bộ kiểm tra tất định…');
    report = await analyze(raw, trans, options);
    if (!job.before) job.before = report.meta.totals;
    job.say(`Trước khi sửa: ${report.meta.totals.error} lỗi · ${report.meta.totals.warn} cảnh báo · ${report.meta.totals.info} lưu ý.`);
  }
  if (job.aborted) return;

  // ---- 2. từ điển ----
  const gloss = new Map();
  if (report) for (const g of report.glossary) { const vi = g.variants?.[0]?.vi; if (vi && !U.HAS_CJK.test(vi)) gloss.set(g.zh, vi); }
  for (const line of String(options.glossaryOverride || '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*(?:=>|=|→)\s*(.+?)\s*$/);
    if (m) gloss.set(m[1], m[2]);
  }

  // ---- 3. lập kế hoạch trường cần xử lý ----
  const rawItems = new Map(extractZones(raw, options).map((i) => [i.key, i]));
  const baseItems = extractZones(base, options);
  const issuesBy = new Map();
  if (report) for (const i of report.issues) {
    const k = i.item + '|' + (i.field || '');
    if (!issuesBy.has(k)) issuesBy.set(k, []);
    issuesBy.get(k).push(i);
  }
  const unknownVars = report ? report.issues.filter((i) => i.rule === 'unknown_var' && i.suggestion).map((i) => ({ name: (i.msg.match(/^“([^”]+)”/) || [])[1], sug: i.suggestion })).filter((x) => x.name) : [];
  const knownVars = [];
  if (report) for (const i of report.issues.filter((x) => x.rule === 'missing_item')) job.say(`Bỏ qua: ${i.msg} (cần thêm mục bằng tay)`, 'warn');

  const syncData = options.dataSync !== false && base.data;
  const tasks = [];
  for (const it of baseItems) {
    if (!it.inScope) continue;
    if (syncData && it.key.startsWith('greet:data.') && baseItems.some((x) => x.key === 'greet:' + it.key.slice('greet:data.'.length))) continue;
    const r = rawItems.get(it.key);
    for (const f of it.fields) {
      const rf = r && r.fields.find((x) => x.name === f.name);
      const iss = issuesBy.get(it.key + '|' + f.name) || [];
      let text = f.text, rebuilt = false;
      if (mode === 'fix' && rf && options.rebuild !== false && pass === 1 && it.zone !== 'greeting' && f.code !== 'text' && f.code !== 'regex'
        && iss.some((i) => i.b64 == null && i.sev === 'error' && (REBUILD_RULES.has(i.rule) || (i.rule === 'url_lost' && it.zone === 'script')))) {
        text = rf.text; rebuilt = true;
        job.say(`Dựng lại từ RAW: ${it.label} › ${f.name} (${[...new Set(iss.filter((i) => i.b64 == null && (REBUILD_RULES.has(i.rule) || i.rule === 'url_lost')).map((i) => i.rule))].join(', ')})`, 'warn', { item: it.key });
      }
      tasks.push({ it, f, text, rawText: rf ? rf.text : null, rebuilt, iss });
    }
  }

  // ---- 3b. học tên thuộc tính/khóa từ code đã dịch: so từng dòng RAW ↔ DỊCH (cùng số dòng),
  // L.抉择 ↔ L['Lựa chọn'] → 抉择 = Lựa chọn. Để dữ liệu dịch mới dùng ĐÚNG tên mà code đang đọc.
  if (mode === 'fix') {
    const votes = new Map();
    const ACC = /\.([\p{L}_$][\p{L}\p{N}_$]*)|\[\s*(['"])([^'"\n]+?)\2\s*\]|(?:^|[{,])\s*(?:([\p{L}_$][\p{L}\p{N}_$]*)|(['"])([^'"\n]+?)\5)\s*:(?!:)/gu;
    const toks = (line) => [...line.matchAll(ACC)].map((m) => (m[1] || m[3] || m[4] || m[6] || '').trim());
    for (const t of tasks) {
      if (t.rebuilt || !t.rawText || !['js', 'ejs', 'html'].includes(t.f.code)) continue;
      const rl = t.rawText.split('\n'), dl = t.text.split('\n');
      if (rl.length !== dl.length) continue;
      for (let i = 0; i < rl.length; i++) {
        if (!U.HAS_HANZI.test(rl[i]) || rl[i] === dl[i]) continue;
        const a = toks(rl[i]), b = toks(dl[i]);
        if (a.length !== b.length) continue;
        a.forEach((h, k) => {
          const v = b[k];
          if (!/^[㐀-䶿一-鿿]+$/.test(h) || !v || U.HAS_CJK.test(v) || v === h) return;
          if (!votes.has(h)) votes.set(h, new Map());
          votes.get(h).set(v, (votes.get(h).get(v) || 0) + 1);
        });
      }
    }
    let learned = 0;
    for (const [h, m] of votes) {
      if (gloss.has(h)) continue;
      const [v] = [...m].sort((x, y) => y[1] - x[1])[0];
      gloss.set(h, v.replace(/_/g, ' ')); learned++;
    }
    if (learned) job.say(`Học được ${learned} tên thuộc tính/khóa từ code đã dịch (vd. ${[...votes.keys()].filter((h) => gloss.has(h)).slice(0, 4).map((h) => h + ' → ' + gloss.get(h)).join(', ')}).`);
  }

  // ---- 4. tạo đơn vị xử lý (trường + khối Base64 bên trong) ----
  const units = [];
  const mkUnit = (task, text, code, rawText, iss, b64, parent) => {
    const scope = task.it.zone === 'greeting' ? technicalRanges(text) : null;
    const b64s = b64 == null ? U.findTextBase64(text) : [];
    const segs = segmentize(text, segLen).filter((s) => !b64s.some((b) => s.start < b.start + b.length && s.end > b.start));
    const starts = lineStarts(text);
    const noteByLine = new Map();
    for (const i of iss) {
      if (!NOTE_RULES.has(i.rule) || i.line == null) continue;
      if ((i.b64 ?? null) !== (b64 ?? null)) continue;
      noteByLine.set(i.line, (noteByLine.get(i.line) ? noteByLine.get(i.line) + ' · ' : '') + i.msg);
    }
    const unit = { task, text, code, rawText, b64, parent, segs: [], subs: [], out: new Map(), notes: new Map(), label: task.it.label + ' › ' + task.f.name + (b64 != null ? ` › Base64 #${b64}` : '') };
    let id = 0;
    for (const s of segs) {
      if (scope && !scope.some(([a, b]) => s.start < b && s.end > a)) continue;
      const line = lineOf(starts, s.start);
      let note = noteByLine.get(line) || '';
      for (const u of unknownVars) if (s.core.includes(u.name)) note += (note ? ' · ' : '') + `“${u.name}” không phải tên biến hợp lệ → dùng “${u.sug}”`;
      const bad = cache.get(cache.key('bad', code, s.core));
      if (bad && U.HAS_CJK.test(s.core)) note += (note ? ' · ' : '') + `Lần trước bản dịch “${String(bad.tr).slice(0, 300)}” làm hỏng cú pháp (${bad.msg}) → dịch lại: khóa object có dấu cách phải đặt trong nháy ('Lựa chọn': …), giữ nguyên dấu phẩy/ngoặc đầu-cuối dòng, tên biến/hàm dùng _ thay dấu cách và phải trùng với nơi khai báo.`;
      if (!U.HAS_CJK.test(s.core) && !note) continue;
      s.id = String(++id); s.line = line;
      if (note) unit.notes.set(s.id, note);
      unit.segs.push(s);
    }
    if (b64 == null) {
      const rb = rawText ? U.findTextBase64(rawText) : [];
      b64s.forEach((b, k) => {
        const dcode = /<\w+[\s>]/.test(b.decoded) ? 'html' : 'js';
        const subIss = iss.filter((i) => i.b64 === k);
        let dtext = b.decoded, rebuiltSub = false;
        if (mode === 'fix' && rb[k] && options.rebuild !== false && pass === 1 && subIss.some((i) => REBUILD_RULES.has(i.rule) && i.sev === 'error')) {
          dtext = rb[k].decoded; rebuiltSub = true;
          job.say(`Dựng lại từ RAW: ${unit.label} › Base64 #${k}`, 'warn', { item: task.it.key });
        }
        const sub = mkUnit(task, dtext, dcode, rb[k] ? rb[k].decoded : null, subIss, k, unit);
        sub.block = b; sub.rebuilt = rebuiltSub;
        unit.subs.push(sub);
      });
    }
    units.push(unit);
    return unit;
  };
  const roots = tasks.map((t) => { const u = mkUnit(t, t.text, t.f.code, t.rawText, t.iss, null, null); u.rebuilt = t.rebuilt; return u; });
  job.stats.fields = roots.filter((u) => u.segs.length || u.subs.some((s) => s.segs.length) || u.rebuilt).length;
  job.stats.rebuilt += units.filter((u) => u.rebuilt).length;
  job.stats.segs += units.reduce((a, u) => a + u.segs.length, 0);

  let allPairs = [];
  for (const u of units) for (const s of u.segs) allPairs.push({ u, s });
  const limit = Number(options.limitSegs) || 0;
  if (limit && allPairs.length > limit) {
    // chạy thử: lấy mẫu rải đều trên toàn thẻ
    const step = allPairs.length / limit;
    allPairs = Array.from({ length: limit }, (_, i) => allPairs[Math.floor(i * step)]);
    job.say(`Chạy thử: chỉ xử lý ${limit} đoạn mẫu. Số lỗi “sau khi sửa” có thể CAO hơn trước vì trường dựng lại từ RAW chỉ được dịch một phần — chỉ dùng để xem chất lượng/tốc độ.`, 'warn');
  }

  // ---- 4b. dùng lại bản dịch trong bộ nhớ đệm ----
  const segKey = (p) => cache.key('seg', p.u.code, p.s.core, p.u.notes.get(p.s.id) || '');
  if (options.useCache !== false) {
    let hit = 0;
    allPairs = allPairs.filter((p) => {
      const v = cache.get(segKey(p));
      if (v == null) return true;
      p.u.out.set(p.s.id, v); hit++;
      return false;
    });
    if (hit) { job.stats.segsCached = (job.stats.segsCached || 0) + hit; job.stats.segsOk += hit; job.say(`Dùng lại ${hit} đoạn đã dịch từ bộ nhớ đệm (không tốn lượt gọi).`, 'ok'); }
  }

  // ---- 5. dịch thuật ngữ/tên biến chưa có trong từ điển ----
  if (options.termPass !== false && allPairs.length && !job.aborted) {
    job.phase = 'Thống nhất tên biến / thuật ngữ';
    const terms = new Set();
    for (const { u, s } of allPairs) {
      const lits = U.extractJsLiterals(s.core);
      for (const l of lits) if (l.key && U.HAS_HANZI.test(l.value) && l.value.length <= 20) terms.add(l.value.trim());
      for (const m of s.core.matchAll(/"path"\s*:\s*"([^"]+)"/g)) m[1].split('/').forEach((p) => { if (U.HAS_HANZI.test(p) && p.length <= 20) terms.add(p.trim()); });
      for (const m of s.core.matchAll(/\.([㐀-䶿一-鿿][\w㐀-䶿一-鿿]{0,15})/g)) terms.add(m[1]);
      // định danh JS trần chứa Hán tự (const 地图容器Schema = …) → dịch thống nhất cụm Hán tự
      if (u.code === 'js' || u.code === 'html' || u.code === 'ejs') {
        let masked = s.core;
        for (const l of [...lits, ...lits.comments.map(([a, b]) => ({ start: a, end: b }))].sort((a, b) => b.start - a.start)) masked = masked.slice(0, l.start) + ' '.repeat(l.end - l.start) + masked.slice(l.end);
        for (const m of masked.matchAll(/[A-Za-z0-9_$]*[㐀-䶿一-鿿][A-Za-z0-9_$㐀-䶿一-鿿]*/g)) for (const h of m[0].match(/[㐀-䶿一-鿿]+/g)) if (h.length <= 20) terms.add(h);
      }
      if (u.code === 'yaml') { const m = s.core.match(/^-?\s*([^:#\s][^:#]{0,20}?)\s*:/); if (m && U.HAS_HANZI.test(m[1])) terms.add(m[1].trim()); }
    }
    let need = [...terms].filter((t) => t && !gloss.has(t) && /^[^\s'"`{}()[\];=<>]+$/.test(t));
    if (options.useCache !== false) need = need.filter((t) => { const v = cache.get(cache.key('term', t)); if (v) { gloss.set(t, v); return false; } return true; });
    if (need.length) {
      job.say(`Dịch trước ${need.length} tên biến/thuật ngữ để dùng thống nhất cho mọi đoạn…`);
      const chunks = [];
      for (let i = 0; i < need.length; i += 400) chunks.push(need.slice(i, i + 400));
      await Promise.all(chunks.map(async (ch) => {
        try {
          const r = await callAI(P.buildTermsPrompt({ cardName, terms: ch, glossary: [...gloss] }));
          const got = P.parseTerms(r.content);
          for (const t of ch) { const v = got.get(t); if (v && !U.HAS_CJK.test(v) && !/[.'"`[\]/]/.test(v)) { gloss.set(t, v); cache.set(cache.key('term', t), v); } }
        } catch (e) {
          if (job.aborted) return;
          if (isFatal(e)) { job.fatal = e; job.say(fatalMsg(e), 'error'); job.ac.abort(e); return; }
          job.stats.errors++; job.say('Lỗi khi dịch thuật ngữ: ' + e.message, 'error');
        }
      }));
    }
  }
  if (job.hardStop) return;
  job.glossary = [...gloss];

  // ---- 6. gửi các lô đoạn cho AI ----
  job.phase = 'AI đang sửa các đoạn';
  const glossArr = [...gloss].sort((a, b) => b[0].length - a[0].length);
  const glossFor = (text) => glossArr.filter(([zh]) => text.includes(zh)).slice(0, 200);
  // Gộp đoạn của NHIỀU mục vào một lượt gọi (provider thường xử lý tuần tự → ít lượt gọi = nhanh hơn, ít token lặp lại)
  const packBatches = (pairs) => {
    const out = [];
    let cur = [], size = 0;
    for (const p of pairs) {
      if (cur.length && (size + p.s.core.length > batchChars || cur.length >= maxSegsPerBatch)) { out.push(cur); cur = []; size = 0; }
      cur.push(p); size += p.s.core.length + 8;
    }
    if (cur.length) out.push(cur);
    return out;
  };
  // Khóa object trần / .thuộc_tính bằng Hán tự có trong từ điển → bản dịch phải dùng đúng tên đó
  // (nếu không, dữ liệu ghi { Lời: … } nhưng code đọc x.Văn → hỏng khi chạy)
  const keyTerms = (core, code) => {
    if (code !== 'js' && code !== 'ejs') return [];
    let masked = core;
    try {
      const lits = U.extractJsLiterals(core);
      for (const l of [...lits, ...lits.comments.map(([a, b]) => ({ start: a, end: b }))].sort((a, b) => b.start - a.start)) masked = masked.slice(0, l.start) + ' '.repeat(l.end - l.start) + masked.slice(l.end);
    } catch (_) { return []; }
    const out = new Set();
    for (const m of masked.matchAll(/(?:^|[{,]\s*)([㐀-䶿一-鿿]+)\s*:(?!:)|\.([㐀-䶿一-鿿]+)(?![\w㐀-䶿一-鿿])/g)) { const h = m[1] || m[2]; if (gloss.has(h)) out.add(h); }
    return [...out];
  };
  const accept = (p, out, retry) => {
    const s = p.s;
    if (out == null) return 'thiếu trong phản hồi';
    const o = out.trim();
    if (!o) return 'rỗng';
    if (!sigOk(o, s.core)) return 'làm thay đổi ký tự cú pháp (nháy/ngoặc/;/=)';
    if (U.HAS_CJK.test(o) && cjkCount(o) >= cjkCount(s.core)) return 'vẫn còn Hán tự';
    if (!retry) {
      const miss = keyTerms(s.core, p.u.code).filter((h) => { const v = gloss.get(h); return ![v, v.replace(/\s+/g, '_'), v.replace(/\s+/g, '')].some((x) => o.includes(x)); });
      if (miss.length) return 'khóa/thuộc tính phải dịch đúng từ điển: ' + miss.map((h) => `${h} → ${gloss.get(h)}`).join(', ');
    }
    return null;
  };
  const runBatch = async (pairs, retry) => {
    if (job.aborted) return [];
    // nhóm theo mục, đánh số toàn lô
    const groups = [];
    pairs.forEach((p, k) => {
      p.bid = String(k + 1);
      let g = groups[groups.length - 1];
      if (!g || g.u !== p.u) groups.push(g = { u: p.u, label: p.u.label, zone: p.u.task.it.zone, code: p.u.code, segments: [] });
      const note = [p.u.notes.get(p.s.id), retry && p.s.why ? 'Lần trước bị loại: ' + p.s.why : ''].filter(Boolean).join(' · ');
      g.segments.push({ id: p.bid, core: p.s.core, note });
    });
    const allText = pairs.map((p) => p.s.core).join('\n');
    const msgs = P.buildSegmentsPrompt({ cardName, groups, glossary: glossFor(allText), knownVars });
    let parsed;
    const t0 = Date.now();
    try {
      const r = await callAI(msgs);
      parsed = P.parseSegments(r.content);
      job.stats.callMs = (job.stats.callMs || 0) + (Date.now() - t0);
      if (r.finish === 'length') job.say(`Phản hồi bị cắt (max_tokens) — nên giảm “ký tự mỗi lượt gọi”.`, 'warn');
    } catch (e) {
      if (job.aborted) return [];
      if (isFatal(e)) { job.fatal = e; job.say(fatalMsg(e), 'error'); job.ac.abort(e); return []; }
      job.stats.errors++;
      job.say(`Lỗi API (${groups.length} mục, ${pairs.length} đoạn): ${e.message}`, 'error');
      parsed = new Map();
    }
    const failed = [];
    for (const p of pairs) {
      const why = accept(p, parsed.get(p.bid), retry);
      if (why) { p.s.why = why; failed.push(p); continue; }
      p.u.out.set(p.s.id, parsed.get(p.bid).trim());
      cache.set(segKey(p), parsed.get(p.bid).trim());
      job.stats.segsOk++;
      if (job.samples.length < 3000) job.samples.push({ label: p.u.label, line: p.s.line, before: p.s.core, after: parsed.get(p.bid).trim() });
    }
    return failed;
  };

  const first = packBatches(allPairs);
  job.stats.batches += first.length;
  job.say(`${allPairs.length} đoạn từ ${units.filter((u) => u.segs.length).length} mục → ${first.length} lượt gọi.`);
  const failedAll = [];
  const work = first.map(async (b) => {
    const f = await runBatch(b, false);
    failedAll.push(...f);
    job.stats.batchesDone++;
  });
  await Promise.all(work);
  if (failedAll.length && !job.aborted) {
    // thử lại 1 lần, lô nhỏ hơn để AI tập trung
    const rb = [];
    for (let i = 0; i < failedAll.length; i += 20) rb.push(failedAll.slice(i, i + 20));
    job.stats.batches += rb.length;
    job.say(`Thử lại ${failedAll.length} đoạn bị loại (${rb.length} lượt gọi)…`);
    const again = await Promise.all(rb.map(async (b) => { const f = await runBatch(b, true); job.stats.batchesDone++; return f; }));
    for (const p of again.flat()) { job.stats.segsFail++; job.say(`Giữ nguyên dòng ${p.s.line} (${p.s.why}) ở ${p.u.label}: ${p.s.core.slice(0, 120)}`, 'warn', { item: p.u.task.it.key, label: p.u.label }); }
  }
  await Promise.all(work);
  if (job.hardStop) return;

  // ---- 7. ghép + chặn lỗi cú pháp mới ----
  job.phase = 'Ghép & kiểm tra cú pháp';
  // Dừng giữa chừng: trường “dựng lại từ RAW” mà chưa dịch xong thì giữ bản DỊCH cũ (đỡ hơn để lẫn tiếng Trung)
  const incompleteRebuild = (u) => job.userCancelled && u.rebuilt && u.segs.some((s) => !u.out.has(s.id));
  const assemble = (u, revert) => {
    const reps = [];
    for (const s of u.segs) if (u.out.has(s.id) && !revert.has(s.id)) reps.push([s.start, s.end, s.lead + u.out.get(s.id) + s.trail]);
    for (const sub of u.subs) if (sub.final !== sub.text || (sub.rebuilt && !sub.skipped)) reps.push([sub.block.start, sub.block.start + sub.block.length, U.encodeBase64Like(sub.final, sub.block)]);
    reps.sort((a, b) => a[0] - b[0]);
    let out = '', last = 0;
    for (const [a, b, t] of reps) { out += u.text.slice(last, a) + t; last = b; }
    return out + u.text.slice(last);
  };
  const finalize = async (u) => {
    for (const sub of u.subs) await finalize(sub);
    if (incompleteRebuild(u)) {
      const orig = u.parent ? u.block.decoded : u.task.f.text;
      job.say(`${u.label}: chưa dịch xong phần dựng lại từ RAW → giữ bản cũ (lần chạy sau sẽ làm tiếp).`, 'warn');
      u.final = orig; u.skipped = true;
      return;
    }
    const revert = new Set();
    let text = assemble(u, revert);
    const before = await firstSyntaxError(u.text, u.code);
    if (!before && u.out.size) {
      for (let k = 0; k < 200; k++) {
        const err = await firstSyntaxError(text, u.code);
        if (!err) break;
        // dòng lỗi trong văn bản mới → dòng tương ứng trong văn bản gốc (đoạn dịch không thêm/bớt dòng)
        const changed = u.segs.filter((s) => u.out.has(s.id) && !revert.has(s.id));
        let cand = changed.filter((s) => s.line === err.line);
        const prev = changed.filter((s) => s.line < (err.line || Infinity)).slice(-1);
        // thử tự vá (khóa có dấu cách, mất dấu phẩy cuối dòng…) trước khi hoàn tác:
        // vá cả dòng lỗi + dòng trước cùng lúc, rồi từng dòng; chỉ giữ nếu node --check thấy lỗi đã lùi về sau
        let fixedOne = false;
        const tryList = [...cand, ...prev].filter((s) => !s.repairTried && repairSeg(u.out.get(s.id), s.core) !== u.out.get(s.id));
        const combos = tryList.length > 1 ? [tryList, ...tryList.map((s) => [s])] : tryList.map((s) => [s]);
        for (const combo of combos) {
          const olds = combo.map((s) => u.out.get(s.id));
          combo.forEach((s, k) => u.out.set(s.id, repairSeg(olds[k], s.core)));
          const e2 = await firstSyntaxError(assemble(u, revert), u.code);
          if (!e2 || (e2.line || 0) > (err.line || 0)) {
            fixedOne = true;
            for (const s of combo) {
              s.repairTried = true; job.stats.segsRepaired = (job.stats.segsRepaired || 0) + 1;
              cache.set(segKey({ u, s }), u.out.get(s.id));
              job.say(`Tự vá cú pháp dòng ${s.line}: ${u.out.get(s.id).slice(0, 120)}`, 'info', { item: u.task.it.key, label: u.label });
            }
            break;
          }
          combo.forEach((s, k) => u.out.set(s.id, olds[k]));
        }
        if (!fixedOne) tryList.forEach((s) => { s.repairTried = true; });
        if (fixedOne) { text = assemble(u, revert); continue; }
        if (!cand.length) cand = prev;
        if (!cand.length) cand = changed.slice(-1);
        if (!cand.length) break;
        for (const s of cand) {
          revert.add(s.id); job.stats.segsReverted++;
          cache.del(segKey({ u, s }));
          cache.set(cache.key('bad', u.code, s.core), { tr: u.out.get(s.id), msg: err.message.slice(0, 120) });
          job.say(`Hoàn tác dòng ${s.line} vì gây lỗi cú pháp (${err.message.slice(0, 100)}) — lần sau AI sẽ được nhắc lỗi này`, 'warn', { item: u.task.it.key, label: u.label });
        }
        text = assemble(u, revert);
      }
      if (await firstSyntaxError(text, u.code)) {
        for (const s of u.segs) { if (u.out.has(s.id) && !revert.has(s.id)) cache.del(segKey({ u, s })); revert.add(s.id); }
        text = assemble(u, revert);
        job.say(`Không tự gỡ được lỗi cú pháp ở ${u.label} → giữ nguyên toàn bộ trường này.`, 'error', { item: u.task.it.key });
      }
    }
    u.final = text;
  };
  for (const u of roots) {
    await finalize(u);
    if (u.final !== u.task.f.text) setAt(base, u.task.f.path, u.final);
    job.stats.fieldsDone++;
  }
  if (job.hardStop) return;

  // ---- 8. sửa tất định (font, URL Markdown, ellipsis, data.*) ----
  const det = applyFixes(base, { fonts: options.fonts !== false, mdlink: options.mdlink !== false, ellipsis: !!options.ellipsis, dataSync: options.dataSync !== false });
  for (const l of det.log) job.say(`Sửa tất định: ${l.fix} ×${l.count} — ${l.label} › ${l.field}`);

  // ---- 9. kiểm tra lại ----
  job.phase = 'Kiểm tra lại kết quả';
  const indentSrc = mode === 'translate' ? rawText : transText;
  const m = indentSrc.match(/^\{\r?\n([ \t]+)"/);
  const indent = m ? m[1] : (/^\{\r?\n/.test(indentSrc) ? '  ' : 0);
  const outText = JSON.stringify(base, null, indent);
  const after = await analyze(raw, base, options);
  job.after = after.meta.totals;
  job.afterChecklist = after.checklist;
  job.result = outText;
  job.say(`Sau khi sửa: ${after.meta.totals.error} lỗi · ${after.meta.totals.warn} cảnh báo · ${after.meta.totals.info} lưu ý.`, 'ok');
}

const jobs = new Map();
function start(input) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = new Job(id, input);
  jobs.set(id, job);
  run(job).then(() => {
    if (job.fatal) { job.state = 'error'; job.phase = 'Lỗi API'; return; }
    if (job.userCancelled) { job.state = 'cancelled'; job.phase = job.result ? 'Đã dừng — đã lưu phần đã dịch' : 'Đã dừng'; return; }
    if (job.state === 'running') { job.state = 'done'; job.phase = 'Hoàn tất'; }
  }).catch((e) => {
    if (job.fatal) { job.state = 'error'; job.phase = 'Lỗi API'; return; }
    if (job.aborted) { job.state = 'cancelled'; return; }
    console.error(e);
    job.state = 'error'; job.say('Lỗi: ' + e.message, 'error');
  }).finally(() => { job.endedAt = Date.now(); job.input = { mode: job.input.mode }; });
  // chỉ giữ 5 job gần nhất
  const keys = [...jobs.keys()];
  for (const k of keys.slice(0, Math.max(0, keys.length - 5))) jobs.delete(k);
  return job;
}

function status(job, since = 0) {
  return {
    id: job.id, state: job.state, phase: job.phase, pass: job.pass || 1, stats: job.stats,
    elapsed: ((job.endedAt || Date.now()) - job.startedAt) / 1000,
    before: job.before || null, after: job.after || null, checklist: job.afterChecklist || null,
    hasResult: !!job.result, savedFile: job.savedFile || null, glossarySize: job.glossary ? job.glossary.length : 0,
    log: job.log.slice(since), logTotal: job.log.length,
  };
}

module.exports = { start, status, jobs, segmentize, sig, sigOk, repairSeg };
