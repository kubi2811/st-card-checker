'use strict';
// Quy trình AI: phân tích tất định → chỉ gửi những đoạn có lỗi cho AI → kiểm tra lại từng đoạn → ghép vào thẻ.
const U = require('../util');
const { extractZones, setAt } = require('../extract');
const { analyze, technicalRanges, scriptBlocks } = require('../analyzer');
const { applyFixes } = require('../fixer');
const { checkSyntax } = require('../jscheck');
const client = require('./client');
const P = require('./prompts');

const REBUILD_RULES = new Set(['skeleton', 'syntax', 'url_lost', 'empty_field']);
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
    this.startedAt = Date.now();
  }
  say(msg, level = 'info', extra) { this.log.push({ t: Date.now(), level, msg, ...(extra || {}) }); if (this.log.length > 20000) this.log.splice(0, 5000); }
  cancel() { this.ac.abort(new Error('Đã dừng')); this.state = 'cancelled'; this.say('Người dùng đã dừng.', 'warn'); }
  get aborted() { return this.ac.signal.aborted; }
}

async function run(job) {
  const { rawText, mode = 'fix', options = {} } = job.input;
  const passes = Math.max(1, Math.min(5, Number(options.passes) || 2));
  let transText = job.input.transText;
  for (let pass = 1; pass <= passes; pass++) {
    const pm = mode === 'translate' && pass > 1 ? 'fix' : mode;
    job.pass = pass;
    if (passes > 1) job.say(`===== Vòng ${pass}/${passes} =====`, 'ok');
    const prevErr = job.after ? job.after.error : Infinity;
    await runPass(job, rawText, transText, pm, pass);
    if (job.aborted || !job.result) return;
    transText = job.result;
    if (!job.after || job.after.error === 0) break;
    if (pass > 1 && job.after.error >= prevErr) { job.say('Vòng này không giảm thêm lỗi → dừng.', 'info'); break; }
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
    retries: 5, signal: job.ac.signal,
    onRetry: (e, n, w) => job.say(`API lỗi (${e.message.slice(0, 160)}) → thử lại lần ${n} sau ${(w / 1000).toFixed(0)}s`, 'warn'),
  };
  const limiter = new Limiter(Math.max(1, Math.min(64, Number(ai.concurrency) || 8)));
  const batchChars = Math.max(500, Number(ai.batchChars) || 6000);
  const maxSegsPerBatch = Math.max(1, Number(ai.batchSegs) || 60);
  const segLen = Math.max(200, Number(ai.segLen) || 900);

  const callAI = async (messages) => {
    const r = await limiter.run(() => client.chat(cfg, messages));
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
        && iss.some((i) => i.b64 == null && REBUILD_RULES.has(i.rule) && i.sev === 'error')) {
        text = rf.text; rebuilt = true;
        job.say(`Dựng lại từ RAW: ${it.label} › ${f.name} (${[...new Set(iss.filter((i) => i.b64 == null && REBUILD_RULES.has(i.rule)).map((i) => i.rule))].join(', ')})`, 'warn', { item: it.key });
      }
      tasks.push({ it, f, text, rawText: rf ? rf.text : null, rebuilt, iss });
    }
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

  // ---- 5. dịch thuật ngữ/tên biến chưa có trong từ điển ----
  if (options.termPass !== false) {
    job.phase = 'Thống nhất tên biến / thuật ngữ';
    const terms = new Set();
    for (const u of units) for (const s of u.segs) {
      const lits = U.extractJsLiterals(s.core);
      for (const l of lits) if (l.key && U.HAS_HANZI.test(l.value) && l.value.length <= 20) terms.add(l.value.trim());
      for (const m of s.core.matchAll(/"path"\s*:\s*"([^"]+)"/g)) m[1].split('/').forEach((p) => { if (U.HAS_HANZI.test(p) && p.length <= 20) terms.add(p.trim()); });
      for (const m of s.core.matchAll(/\.([㐀-䶿一-鿿][\w㐀-䶿一-鿿]{0,15})/g)) terms.add(m[1]);
      if (u.code === 'yaml') { const m = s.core.match(/^-?\s*([^:#\s][^:#]{0,20}?)\s*:/); if (m && U.HAS_HANZI.test(m[1])) terms.add(m[1].trim()); }
    }
    const need = [...terms].filter((t) => t && !gloss.has(t) && /^[^\s'"`{}()[\];=<>]+$/.test(t));
    if (need.length) {
      job.say(`Dịch trước ${need.length} tên biến/thuật ngữ để dùng thống nhất cho mọi đoạn…`);
      const chunks = [];
      for (let i = 0; i < need.length; i += 150) chunks.push(need.slice(i, i + 150));
      await Promise.all(chunks.map(async (ch) => {
        try {
          const r = await callAI(P.buildTermsPrompt({ cardName, terms: ch, glossary: [...gloss] }));
          const got = P.parseTerms(r.content);
          for (const t of ch) { const v = got.get(t); if (v && !U.HAS_CJK.test(v) && !/[.'"`[\]/]/.test(v)) gloss.set(t, v); }
        } catch (e) { job.stats.errors++; job.say('Lỗi khi dịch thuật ngữ: ' + e.message, 'error'); }
      }));
    }
  }
  if (job.aborted) return;
  job.glossary = [...gloss];

  // ---- 6. gửi các lô đoạn cho AI ----
  job.phase = 'AI đang sửa các đoạn';
  const glossArr = [...gloss].sort((a, b) => b[0].length - a[0].length);
  const glossFor = (text) => glossArr.filter(([zh]) => text.includes(zh)).slice(0, 200);
  const batchesOf = (u, segs) => {
    const out = [];
    let cur = [], size = 0;
    for (const s of segs) {
      if (cur.length && (size + s.core.length > batchChars || cur.length >= maxSegsPerBatch)) { out.push(cur); cur = []; size = 0; }
      cur.push(s); size += s.core.length;
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const accept = (s, out) => {
    if (out == null) return 'thiếu trong phản hồi';
    const o = out.trim();
    if (!o) return 'rỗng';
    if (sig(o) !== sig(s.core)) return 'làm thay đổi ký tự cú pháp (nháy/ngoặc/;/=)';
    if (U.HAS_CJK.test(o) && cjkCount(o) >= cjkCount(s.core)) return 'vẫn còn Hán tự';
    return null;
  };
  const runBatch = async (u, segs, retry) => {
    if (job.aborted) return [];
    const msgs = P.buildSegmentsPrompt({ cardName, label: u.label, zone: u.task.it.zone, code: u.code, glossary: glossFor(segs.map((s) => s.core).join('\n')), segments: segs, notes: retry ? new Map(segs.map((s) => [s.id, [u.notes.get(s.id), 'Lần trước bị loại: ' + s.why].filter(Boolean).join(' · ')])) : u.notes, knownVars });
    let parsed;
    try {
      const r = await callAI(msgs);
      parsed = P.parseSegments(r.content);
      if (r.finish === 'length') job.say(`Phản hồi bị cắt (max_tokens) ở ${u.label} — nên giảm “ký tự mỗi lô”.`, 'warn');
    } catch (e) {
      if (job.aborted) return [];
      job.stats.errors++;
      job.say(`Lỗi API ở ${u.label}: ${e.message}`, 'error', { item: u.task.it.key });
      parsed = new Map();
    }
    const failed = [];
    for (const s of segs) {
      const why = accept(s, parsed.get(s.id));
      if (why) { s.why = why; failed.push(s); continue; }
      u.out.set(s.id, parsed.get(s.id).trim());
    }
    return failed;
  };

  const work = [];
  for (const u of units) {
    if (!u.segs.length) continue;
    for (const b of batchesOf(u, u.segs)) {
      job.stats.batches++;
      work.push((async () => {
        let failed = await runBatch(u, b, false);
        if (failed.length && !job.aborted) {
          const rb = batchesOf(u, failed);
          job.stats.batches += rb.length;
          const again = await Promise.all(rb.map((x) => runBatch(u, x, true).finally(() => { job.stats.batchesDone++; })));
          failed = again.flat();
        }
        for (const s of failed) { job.stats.segsFail++; job.say(`Giữ nguyên dòng ${s.line} (${s.why}): ${s.core.slice(0, 120)}`, 'warn', { item: u.task.it.key, label: u.label }); }
        job.stats.segsOk += b.length - failed.length;
        job.stats.batchesDone++;
      })());
    }
  }
  await Promise.all(work);
  if (job.aborted) return;

  // ---- 7. ghép + chặn lỗi cú pháp mới ----
  job.phase = 'Ghép & kiểm tra cú pháp';
  const assemble = (u, revert) => {
    const reps = [];
    for (const s of u.segs) if (u.out.has(s.id) && !revert.has(s.id)) reps.push([s.start, s.end, s.lead + u.out.get(s.id) + s.trail]);
    for (const sub of u.subs) if (sub.final !== sub.text || sub.rebuilt) reps.push([sub.block.start, sub.block.start + sub.block.length, U.encodeBase64Like(sub.final, sub.block)]);
    reps.sort((a, b) => a[0] - b[0]);
    let out = '', last = 0;
    for (const [a, b, t] of reps) { out += u.text.slice(last, a) + t; last = b; }
    return out + u.text.slice(last);
  };
  const finalize = async (u) => {
    for (const sub of u.subs) await finalize(sub);
    const revert = new Set();
    let text = assemble(u, revert);
    const before = await firstSyntaxError(u.text, u.code);
    if (!before && u.out.size) {
      for (let k = 0; k < 80; k++) {
        const err = await firstSyntaxError(text, u.code);
        if (!err) break;
        // dòng lỗi trong văn bản mới → dòng tương ứng trong văn bản gốc (đoạn dịch không thêm/bớt dòng)
        const changed = u.segs.filter((s) => u.out.has(s.id) && !revert.has(s.id));
        let cand = changed.filter((s) => s.line === err.line);
        if (!cand.length) cand = changed.filter((s) => s.line <= (err.line || Infinity)).slice(-1);
        if (!cand.length) cand = changed.slice(-1);
        if (!cand.length) break;
        for (const s of cand) { revert.add(s.id); job.stats.segsReverted++; job.say(`Hoàn tác dòng ${s.line} vì gây lỗi cú pháp (${err.message.slice(0, 100)})`, 'warn', { item: u.task.it.key, label: u.label }); }
        text = assemble(u, revert);
      }
      if (await firstSyntaxError(text, u.code)) {
        for (const s of u.segs) revert.add(s.id);
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
  if (job.aborted) return;

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
    if (job.state === 'running') { job.state = 'done'; job.phase = 'Hoàn tất'; }
  }).catch((e) => {
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
    hasResult: !!job.result, glossarySize: job.glossary ? job.glossary.length : 0,
    log: job.log.slice(since), logTotal: job.log.length,
  };
}

module.exports = { start, status, jobs, segmentize, sig };
