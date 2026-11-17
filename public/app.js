'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CJK = /([　-〿㐀-䶿一-丧丩-鿿豈-﫿︰-﹏＀-￯]+)/g;
const ZONES = { worldbook: 'Worldbook (EJS / MVU)', greeting: 'Lời mở đầu', script: 'Scripts (tavern_helper)', regex: 'Regex' };
const SEV = { error: 'Lỗi', warn: 'Cảnh báo', info: 'Lưu ý' };

const S = { raw: null, trans: null, report: null, sel: null, viewer: null };

// ---------------- tải file ----------------
function setupDrop(zoneId, inputId, nameId, side) {
  const z = $(zoneId), inp = $(inputId);
  const load = async (file) => {
    if (!file) return;
    const text = await file.text();
    try { S[side] = { name: file.name, text, obj: JSON.parse(text.replace(/^﻿/, '')) }; }
    catch (e) { status(`${file.name}: JSON không hợp lệ — ${e.message}`, true); return; }
    refreshDrops();
  };
  inp.addEventListener('change', () => load(inp.files[0]));
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); load(e.dataTransfer.files[0]); });
}
function refreshDrops() {
  for (const [side, id, nid] of [['raw', '#dropRaw', '#nameRaw'], ['trans', '#dropTrans', '#nameTrans']]) {
    const f = S[side];
    $(id).classList.toggle('loaded', !!f);
    $(nid).textContent = f ? `${f.name} · ${(f.text.length / 1024 / 1024).toFixed(2)} MB · tên thẻ: ${f.obj?.data?.name || f.obj?.name || '?'}` : '';
  }
  $('#btnAnalyze').disabled = !(S.raw && S.trans);
  if (window.aiRefresh) window.aiRefresh();
}
setupDrop('#dropRaw', '#fileRaw', '#nameRaw', 'raw');
setupDrop('#dropTrans', '#fileTrans', '#nameTrans', 'trans');
$('#btnSwap').onclick = () => { [S.raw, S.trans] = [S.trans, S.raw]; refreshDrops(); };

function status(msg, err) { const el = $('#status'); el.textContent = msg; el.classList.toggle('err', !!err); }

// ---------------- phân tích ----------------
$('#btnAnalyze').onclick = analyze;
async function analyze() {
  $('#btnAnalyze').disabled = true;
  status('Đang phân tích… (kiểm tra cú pháp bằng node --check có thể mất vài giây)');
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: S.raw.text, trans: S.trans.text, options: { includeTaggedEntries: $('#optTagged').checked } }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    S.report = j;
    S.issuesByItem = new Map();
    for (const i of j.issues) { if (!S.issuesByItem.has(i.item)) S.issuesByItem.set(i.item, []); S.issuesByItem.get(i.item).push(i); }
    S.itemMap = new Map(j.items.map((i) => [i.key, i]));
    status(`Xong trong ${(j.meta.ms / 1000).toFixed(1)} giây.`);
    render();
  } catch (e) { status('Lỗi: ' + e.message, true); }
  $('#btnAnalyze').disabled = false;
}

function render() {
  const R = S.report;
  $('#result').classList.remove('hidden');
  const t = R.meta.totals;
  $('#totals').innerHTML = `
    <span class="pill error">${t.error} lỗi</span><span class="pill warn">${t.warn} cảnh báo</span><span class="pill info">${t.info} lưu ý</span>
    <span class="muted">RAW: <b>${esc(R.meta.rawName)}</b> → DỊCH: <b>${esc(R.meta.transName)}</b> · ${R.meta.zones.map((z) => `${ZONES[z.zone].split(' (')[0]}: ${z.inScope}/${z.total} trong phạm vi`).join(' · ')}</span>`;
  $('#checklist').innerHTML = R.checklist.map((c) => `<div class="ck ${c.pass ? '' : 'fail'}"><b>${c.pass ? '✅' : '❌'} ${esc(c.title)}</b><span>${esc(c.detail)}</span></div>`).join('');
  renderList();
  renderRules();
  renderGlossary();
  $('#reportText').value = buildReport();
  const first = R.items.find((i) => i.counts.error) || R.items.find((i) => i.counts.warn);
  if (first) selectItem(first.key); else $('#detail').innerHTML = '<p>🎉 Không phát hiện lỗi nào.</p>';
}

// ---------------- danh sách mục ----------------
$('#q').oninput = renderList; $('#sevFilter').onchange = renderList;
function renderList() {
  const R = S.report, q = $('#q').value.toLowerCase(), f = $('#sevFilter').value;
  const glob = S.issuesByItem;
  let html = '';
  for (const z of Object.keys(ZONES)) {
    const its = R.items.filter((i) => i.zone === z && (glob.get(i.key) || (f === 'all' && i.inScope)))
      .filter((i) => f !== 'error' || i.counts.error)
      .filter((i) => !q || (i.label + ' ' + (i.rawLabel || '')).toLowerCase().includes(q));
    // greeting/global issue keys có thể không có item tương ứng
    if (!its.length) continue;
    html += `<div class="zone-h">${ZONES[z]} (${its.length})</div>`;
    html += its.map((i) => `<div class="it ${S.sel === i.key ? 'sel' : ''}" data-k="${esc(i.key)}"><div class="lbl">${esc(i.label)}${i.rawLabel && i.rawLabel !== i.label ? `<small>${esc(i.rawLabel)}</small>` : ''}${i.status !== 'paired' ? `<small>${i.status === 'missing' ? '⚠ thiếu trong DỊCH' : '＋ không có trong RAW'}</small>` : ''}</div><div class="cnt">${cnt(i.counts)}</div></div>`).join('');
  }
  const orphan = [...glob.keys()].filter((k) => !S.itemMap.has(k));
  if (orphan.length) html += `<div class="zone-h">Khác</div>` + orphan.map((k) => `<div class="it ${S.sel === k ? 'sel' : ''}" data-k="${esc(k)}"><div class="lbl">${esc(k)}</div><div class="cnt">${cnt(countOf(glob.get(k)))}</div></div>`).join('');
  $('#itemList').innerHTML = html || '<p class="muted">Không có mục nào khớp bộ lọc.</p>';
  $('#itemList').querySelectorAll('.it').forEach((el) => (el.onclick = () => selectItem(el.dataset.k)));
}
const countOf = (arr) => arr.reduce((a, i) => (a[i.sev]++, a), { error: 0, warn: 0, info: 0 });
const cnt = (c) => ['error', 'warn', 'info'].filter((s) => c[s]).map((s) => `<span class="pill ${s}">${c[s]}</span>`).join('') || '<span class="pill ok">✓</span>';

function selectItem(key) {
  S.sel = key;
  document.querySelectorAll('.it').forEach((el) => el.classList.toggle('sel', el.dataset.k === key));
  const it = S.itemMap.get(key);
  const issues = S.issuesByItem.get(key) || [];
  const R = S.report;
  let html = `<h2>${esc(it ? it.label : key)}</h2><div class="sub">${it ? `${ZONES[it.zone]} · <code>${esc(key)}</code>${it.rawLabel ? ` · RAW: ${esc(it.rawLabel)}` : ''}${it.enabled === false ? ' · (đang tắt)' : ''}` : ''}</div>`;
  if (it) {
    html += `<div class="fieldbar">` + it.fields.filter((f) => f.lenRaw || f.lenTrans).map((f) => `<button class="ghost sm" data-f="${esc(f.name)}">So sánh “${esc(f.name)}” <span class="muted">(${f.lenRaw.toLocaleString()} → ${f.lenTrans.toLocaleString()} ký tự)</span></button>`).join('') + `</div>`;
  }
  const groups = new Map();
  for (const i of issues) { if (!groups.has(i.rule)) groups.set(i.rule, []); groups.get(i.rule).push(i); }
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...groups.entries()].sort((a, b) => order[worst(a[1])] - order[worst(b[1])]);
  html += sorted.map(([rule, arr], gi) => `<details class="rule" ${gi < 3 ? 'open' : ''}><summary><span class="pill ${worst(arr)}">${arr.length}</span><b>${esc(R.rules[rule]?.title || rule)}</b></summary>` +
    arr.map((i, k) => `<div class="iss sev-${i.sev}" data-r="${esc(rule)}" data-k="${k}"><span class="ln">${i.b64 != null ? `b64#${i.b64} ` : ''}${i.line ? 'L' + i.line : '—'}</span><span class="msg">${esc(i.msg)}${i.field ? ` <span class="muted">[${esc(i.field)}]</span>` : ''}${i.snippet ? `<span class="snip">${hlCjk(esc(i.snippet))}</span>` : ''}${i.rawSnippet ? `<span class="snip">RAW: ${esc(i.rawSnippet)}</span>` : ''}</span></div>`).join('') + `</details>`).join('');
  if (!issues.length) html += '<p class="ok">✓ Không có lỗi trong mục này.</p>';
  $('#detail').innerHTML = html;
  $('#detail').querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => openViewer(key, b.dataset.f, null)));
  $('#detail').querySelectorAll('.iss').forEach((el) => (el.onclick = () => { const i = groups.get(el.dataset.r)[+el.dataset.k]; if (i.more) return; openViewer(i.item, i.field, i); }));
}
const worst = (arr) => (arr.some((i) => i.sev === 'error') ? 'error' : arr.some((i) => i.sev === 'warn') ? 'warn' : 'info');
const hlCjk = (html) => html.replace(CJK, '<mark>$1</mark>');

// ---------------- lỗi theo loại ----------------
function renderRules() {
  const R = S.report;
  const by = new Map();
  for (const i of R.issues) { if (!by.has(i.rule)) by.set(i.rule, []); by.get(i.rule).push(i); }
  const cats = { cjk: 'Hán tự', sync: 'Đồng bộ biến & tham chiếu', syntax: 'Cú pháp & URL', struct: 'Cấu trúc so với RAW', ui: 'Giao diện & font' };
  let html = '';
  for (const [cat, title] of Object.entries(cats)) {
    const rules = [...by.keys()].filter((r) => R.rules[r]?.cat === cat);
    if (!rules.length) continue;
    html += `<h3>${title}</h3>`;
    for (const r of rules) {
      const arr = by.get(r);
      html += `<details class="rule"><summary><span class="pill ${worst(arr)}">${arr.length}</span><b>${esc(R.rules[r].title)}</b></summary>` +
        arr.slice(0, 500).map((i, k) => `<div class="iss sev-${i.sev}" data-r="${r}" data-k="${k}"><span class="ln">${i.line ? 'L' + i.line : '—'}</span><span class="msg"><b>${esc(S.itemMap.get(i.item)?.label || i.item)}</b> ${i.field ? `<span class="muted">[${esc(i.field)}]</span>` : ''} — ${esc(i.msg)}${i.snippet ? `<span class="snip">${hlCjk(esc(i.snippet))}</span>` : ''}</span></div>`).join('') +
        (arr.length > 500 ? `<div class="iss"><span></span><span class="muted">… còn ${arr.length - 500} mục, xem trong tab “Lỗi theo mục”.</span></div>` : '') + `</details>`;
    }
  }
  $('#ruleView').innerHTML = html || '<p>🎉 Không có lỗi.</p>';
  $('#ruleView').querySelectorAll('.iss[data-r]').forEach((el) => (el.onclick = () => { const i = by.get(el.dataset.r)[+el.dataset.k]; if (i.more) return; openViewer(i.item, i.field, i); }));
}

// ---------------- bảng thuật ngữ ----------------
$('#gq').oninput = renderGlossary; $('#gConflict').onchange = renderGlossary;
function renderGlossary() {
  const q = $('#gq').value.toLowerCase(), only = $('#gConflict').checked;
  const g = S.report.glossary.filter((x) => (!only || x.conflict) && (!q || x.zh.toLowerCase().includes(q) || x.variants.some((v) => v.vi.toLowerCase().includes(q))));
  const total = S.report.glossary.length, conf = S.report.glossary.filter((x) => x.conflict).length;
  $('#glossView').innerHTML = `<p class="muted">${total} thuật ngữ · <b>${conf}</b> bị dịch nhiều kiểu · đang hiện ${Math.min(g.length, 1500)}</p>` +
    `<table><thead><tr><th style="width:22%">Gốc (RAW)</th><th>Bản dịch trong DỊCH</th><th style="width:90px">Ngữ cảnh</th></tr></thead><tbody>` +
    g.slice(0, 1500).map((x) => `<tr><td>${x.conflict ? '⚠️ ' : ''}${esc(x.zh)}</td><td>${x.variants.map((v, k) => `<span class="v ${k === 0 ? 'top' : ''}" title="${esc(v.locs.map((l) => `${S.itemMap.get(l.item)?.label || l.item} [${l.field}] L${l.line ?? '?'}`).join('\n'))}">${esc(v.vi)} <small>×${v.count}</small></span>`).join('')}</td><td>${x.keyCtx ? 'khóa / đường dẫn' : 'chuỗi'}</td></tr>`).join('') + `</tbody></table>`;
}
$('#btnGlossCsv').onclick = () => {
  const rows = [['goc', 'ban_dich', 'so_lan', 'xung_dot', 'ngu_canh']];
  for (const x of S.report.glossary) for (const v of x.variants) rows.push([x.zh, v.vi, v.count, x.conflict ? 'x' : '', x.keyCtx ? 'key' : 'string']);
  download('thuat-ngu.csv', '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
};

// ---------------- trình xem so sánh ----------------
const getAt = (o, p) => (p || []).reduce((a, k) => (a == null ? a : a[k]), o);
function openViewer(itemKey, fieldName, issue) {
  const it = S.itemMap.get(itemKey);
  if (!it) return;
  const f = it.fields.find((x) => x.name === fieldName) || it.fields.find((x) => x.name === 'content') || it.fields[0];
  let raw, trans, title = `${it.label} — ${f.name}`;
  if (issue && issue.b64 != null) {
    const d = S.report.decoded[`${itemKey}|${f.name}|${issue.b64}`] || {};
    raw = d.raw ?? '(RAW không có khối Base64 tương ứng)'; trans = d.trans ?? '';
    title += ` — Base64 #${issue.b64} (đã giải mã, nằm ở dòng ${d.line} của trường)`;
  } else {
    raw = f.rawPath ? getAt(S.raw.obj, f.rawPath) ?? '' : '(không có trong RAW)';
    trans = f.path ? getAt(S.trans.obj, f.path) ?? '' : '(không có trong DỊCH)';
  }
  S.viewer = { raw: String(raw), trans: String(trans), line: issue?.line || null, rawLine: issue?.rawLine || issue?.line || null };
  $('#viewerTitle').innerHTML = esc(title) + (issue ? `<br><small class="muted">${esc(issue.msg)}</small>` : '');
  const big = Math.max(S.viewer.raw.length, S.viewer.trans.length) > 400000;
  $('#vFull').checked = !issue && !big;
  drawViewer();
  $('#viewer').classList.remove('hidden');
}
$('#vFull').onchange = drawViewer;
$('#vClose').onclick = () => $('#viewer').classList.add('hidden');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#viewer').classList.add('hidden'); });
function drawViewer() {
  const v = S.viewer, full = $('#vFull').checked;
  renderCode($('#vRaw'), v.raw, v.rawLine, full);
  renderCode($('#vTrans'), v.trans, v.line, full);
}
function renderCode(el, text, line, full) {
  const lines = text.split('\n');
  let from = 0, to = lines.length;
  if (!full) { const c = line || 1; from = Math.max(0, c - 60); to = Math.min(lines.length, c + 60); }
  let html = from > 0 ? `<div class="gap">… ${from} dòng phía trên (bật “Xem toàn bộ”)</div>` : '';
  for (let i = from; i < to; i++) {
    const t = lines[i].length > 4000 ? lines[i].slice(0, 4000) + ' …(dòng quá dài, đã cắt hiển thị)' : lines[i];
    html += `<div class="l ${line === i + 1 ? 'hl' : ''}" ${line === i + 1 ? 'id="tgt"' : ''}><span class="n">${i + 1}</span><span class="t">${hlCjk(esc(t)) || ' '}</span></div>`;
  }
  if (to < lines.length) html += `<div class="gap">… ${lines.length - to} dòng phía dưới</div>`;
  el.innerHTML = html;
  const tgt = el.querySelector('.hl');
  if (tgt) setTimeout(() => (el.scrollTop = tgt.offsetTop - el.clientHeight / 3), 0); else el.scrollTop = 0;
}

// ---------------- sửa tự động ----------------
$('#btnFix').onclick = async () => {
  const opts = { fonts: $('#fxFonts').checked, mdlink: $('#fxMd').checked, dataSync: $('#fxData').checked, ellipsis: $('#fxEllipsis').checked, glossary: $('#fxGloss').checked, punct: $('#fxPunct').checked, includeTaggedEntries: $('#optTagged').checked };
  const glossary = S.report.glossary.filter((g) => !g.conflict && !/[㐀-鿿]/.test(g.variants[0].vi)).map((g) => [g.zh, g.variants[0].vi]);
  $('#btnFix').disabled = true;
  $('#fixLog').innerHTML = '<p class="muted">Đang sửa…</p>';
  try {
    const r = await fetch('/api/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trans: S.trans.text, options: opts, glossary }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const total = j.log.reduce((a, l) => a + l.count, 0);
    const name = S.trans.name.replace(/(\.fixed)?\.json$/i, '') + '.fixed.json';
    if (total) download(name, j.text, 'application/json');
    $('#fixLog').innerHTML = total
      ? `<p class="ok">✓ Đã sửa ${total} chỗ, đã tải <b>${esc(name)}</b>. Đang phân tích lại bản đã sửa…</p><table><thead><tr><th>Mục</th><th>Trường</th><th>Sửa</th><th>Số chỗ</th></tr></thead><tbody>${j.log.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.field)}</td><td>${esc(l.fix)}</td><td>${l.count}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Không có gì để sửa với các tuỳ chọn đã chọn.</p>';
    if (total) {
      S.trans = { name, text: j.text, obj: JSON.parse(j.text) };
      refreshDrops();
      const keep = $('#fixLog').innerHTML;
      await analyze();
      $('#fixLog').innerHTML = keep.replace('Đang phân tích lại bản đã sửa…', 'Kết quả bên trên đã là của bản đã sửa.');
    }
  } catch (e) { $('#fixLog').innerHTML = `<p class="warnTxt">Lỗi: ${esc(e.message)}</p>`; }
  $('#btnFix').disabled = false;
};

// ---------------- báo cáo ----------------
function buildReport() {
  const R = S.report;
  const L = [];
  L.push(`# Báo cáo kiểm tra thẻ: ${R.meta.transName}`, '', `- File RAW: \`${S.raw.name}\` (${R.meta.rawName})`, `- File DỊCH: \`${S.trans.name}\``, `- Tổng: **${R.meta.totals.error} lỗi**, ${R.meta.totals.warn} cảnh báo, ${R.meta.totals.info} lưu ý`, '', '## Checklist', '');
  for (const c of R.checklist) L.push(`- [${c.pass ? 'x' : ' '}] **${c.title}** — ${c.detail}`);
  L.push('', '## Chi tiết (lỗi & cảnh báo)', '');
  const by = new Map();
  for (const i of R.issues) { if (i.sev === 'info') continue; if (!by.has(i.item)) by.set(i.item, []); by.get(i.item).push(i); }
  for (const [k, arr] of by) {
    L.push(`### ${S.itemMap.get(k)?.label || k}`, '');
    for (const i of arr.slice(0, 80)) L.push(`- ${i.sev === 'error' ? '🔴' : '🟡'} ${R.rules[i.rule]?.title || i.rule}${i.field ? ` [${i.field}]` : ''}${i.b64 != null ? ` (Base64 #${i.b64})` : ''}${i.line ? ` dòng ${i.line}` : ''}: ${i.msg}`);
    if (arr.length > 80) L.push(`- … và ${arr.length - 80} mục khác`);
    L.push('');
  }
  return L.join('\n');
}
$('#btnReportMd').onclick = () => download('bao-cao-kiem-tra.md', $('#reportText').value, 'text/markdown');
$('#btnCopyReport').onclick = async () => { await navigator.clipboard.writeText($('#reportText').value); $('#btnCopyReport').textContent = 'Đã sao chép ✓'; setTimeout(() => ($('#btnCopyReport').textContent = 'Sao chép báo cáo'), 1500); };
$('#btnBundle').onclick = () => {
  const R = S.report;
  const out = { note: 'Gói trích xuất: chỉ các mục trong 4 vùng lõi có lỗi/cảnh báo. RAW = gốc, DICH = bản cần sửa.', raw_name: R.meta.rawName, trans_name: R.meta.transName, items: [] };
  for (const it of R.items) {
    const iss = (S.issuesByItem.get(it.key) || []).filter((i) => i.sev !== 'info');
    if (!it.inScope || !iss.length) continue;
    out.items.push({
      key: it.key, zone: it.zone, label: it.label,
      issues: iss.slice(0, 60).map((i) => `${i.rule}${i.line ? ' L' + i.line : ''}: ${i.msg}`),
      fields: it.fields.filter((f) => f.code !== 'text' || iss.some((i) => i.field === f.name)).map((f) => ({ name: f.name, path: f.path, RAW: f.rawPath ? getAt(S.raw.obj, f.rawPath) : null, DICH: f.path ? getAt(S.trans.obj, f.path) : null })),
    });
  }
  download('goi-trich-xuat.json', JSON.stringify(out, null, 2), 'application/json');
};

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- tab ----------------
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab));
}));

// ---------------- cập nhật ----------------
function showUpd(s) {
  $('#ver').textContent = 'v' + s.version + (s.current ? ` (${s.current.slice(0, 7)})` : '');
  const box = $('#upd');
  box.classList.toggle('has', !!s.hasUpdate);
  $('#btnApplyUpd').classList.toggle('hidden', !s.hasUpdate);
  if (s.applying) $('#updText').textContent = 'Đang cập nhật…';
  else if (s.hasUpdate) $('#updText').innerHTML = `🔔 Có bản mới${s.latestVersion ? ' v' + esc(s.latestVersion) : ''}: <i>${esc((s.message || '').split('\n')[0].slice(0, 80))}</i>`;
  else if (s.error) $('#updText').textContent = 'Không kiểm tra được cập nhật (offline?)';
  else if (s.lastCheck) $('#updText').textContent = `Bản mới nhất ✓ · kiểm tra lúc ${new Date(s.lastCheck).toLocaleTimeString()}`;
  else $('#updText').textContent = 'Chưa kiểm tra cập nhật';
}
async function pollUpd() { try { showUpd(await (await fetch('/api/update/status')).json()); } catch (_) {} }
$('#btnCheckUpd').onclick = async () => { $('#updText').textContent = 'Đang kiểm tra…'; showUpd(await (await fetch('/api/update/check', { method: 'POST' })).json()); };
$('#btnApplyUpd').onclick = async () => {
  if (!confirm('Tải bản mới từ GitHub và khởi động lại công cụ? (Kết quả phân tích hiện tại sẽ mất, file của bạn không bị ảnh hưởng.)')) return;
  $('#updText').textContent = 'Đang tải bản mới…';
  const pid = (await (await fetch('/api/version')).json()).pid;
  const r = await fetch('/api/update/apply', { method: 'POST' });
  const j = await r.json();
  if (!r.ok) { $('#updText').textContent = 'Cập nhật lỗi: ' + j.error; return; }
  $('#updText').textContent = 'Đang khởi động lại…';
  const t0 = Date.now();
  const wait = async () => {
    try { const v = await (await fetch('/api/version')).json(); if (v.pid !== pid) return location.reload(); } catch (_) {}
    if (Date.now() - t0 < 60000) setTimeout(wait, 1000); else $('#updText').textContent = 'Không thấy công cụ khởi động lại — hãy chạy lại start.';
  };
  setTimeout(wait, 1500);
};
pollUpd();
setInterval(pollUpd, 60000);

// ================= Sửa bằng AI =================
(() => {
  const LS = 'stcc.ai.v1';
  const store = { get() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (_) { return {}; } }, set(v) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch (_) { /* bỏ qua */ } } };
  const F = { aiUrl: 'v', aiKey: 'v', aoRebuild: 'c', aoTerms: 'c', aoFonts: 'c', aoData: 'c', aoEllipsis: 'c', aoConc: 'v', aoBatch: 'v', aoSegs: 'v', aoSegLen: 'v', aoPasses: 'v', aoTemp: 'v', aoMax: 'v', aoGloss: 'v' };
  const saved = store.get();
  for (const [id, t] of Object.entries(F)) {
    const el = $('#' + id);
    if (saved[id] !== undefined) { if (t === 'c') el.checked = saved[id]; else el.value = saved[id]; }
    el.addEventListener('change', save);
  }
  if (saved.models) fillModels(saved.models, saved.model);
  if (saved.mode) { const r = document.querySelector(`input[name=aiMode][value=${saved.mode}]`); if (r) r.checked = true; }
  document.querySelectorAll('input[name=aiMode]').forEach((r) => r.addEventListener('change', () => { save(); refresh(); }));
  $('#aiModel').addEventListener('change', () => { save(); refresh(); });
  function save() {
    const v = { ...store.get() };
    for (const [id, t] of Object.entries(F)) v[id] = t === 'c' ? $('#' + id).checked : $('#' + id).value;
    v.model = $('#aiModel').value; v.mode = mode();
    store.set(v);
  }
  const mode = () => document.querySelector('input[name=aiMode]:checked').value;
  function refresh() {
    const ok = S.raw && (mode() === 'translate' || S.trans) && $('#aiUrl').value.trim() && $('#aiModel').value;
    $('#aiStart').disabled = !ok || !!J.id && J.running;
    const need = !S.raw ? 'Cần chọn File RAW.' : (mode() === 'fix' && !S.trans ? 'Cần chọn File DỊCH (hoặc chọn “Dịch mới từ RAW”).' : (!$('#aiModel').value ? 'Nhập URL + key rồi bấm “Tải model”.' : ''));
    if (need || $('#aiMsg').dataset.need) $('#aiMsg').textContent = need;
    $('#aiMsg').dataset.need = need ? '1' : '';
  }
  window.aiRefresh = refresh;
  $('#aiUrl').addEventListener('input', refresh);
  $('#aiEye').onclick = () => { const k = $('#aiKey'); k.type = k.type === 'password' ? 'text' : 'password'; };

  function fillModels(list, sel) {
    const s = $('#aiModel');
    s.innerHTML = list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    const pick = sel && list.includes(sel) ? sel : (list.find((m) => /flash/i.test(m)) || list[0] || '');
    s.value = pick;
  }
  $('#aiLoad').onclick = async () => {
    const b = $('#aiLoad'); b.disabled = true; $('#aiMsg').textContent = 'Đang tải danh sách model…';
    try {
      const r = await fetch('/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseURL: $('#aiUrl').value, apiKey: $('#aiKey').value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (!j.models.length) throw new Error('Provider không trả về model nào');
      $('#aiUrl').value = j.baseURL;
      fillModels(j.models, $('#aiModel').value || store.get().model);
      const v = store.get(); v.models = j.models; store.set(v); save();
      $('#aiMsg').textContent = `Đã tải ${j.models.length} model.`;
    } catch (e) { $('#aiMsg').textContent = 'Không tải được model: ' + e.message; }
    b.disabled = false; refresh();
  };

  const J = { id: null, since: 0, running: false, timer: null };
  $('#aiStart').onclick = async () => {
    save();
    const n = (id, d) => (Number($('#' + id).value) || d);
    const body = {
      mode: mode(), raw: S.raw.text, trans: S.trans ? S.trans.text : null,
      options: { includeTaggedEntries: $('#optTagged').checked, rebuild: $('#aoRebuild').checked, termPass: $('#aoTerms').checked, fonts: $('#aoFonts').checked, mdlink: $('#aoFonts').checked, dataSync: $('#aoData').checked, ellipsis: $('#aoEllipsis').checked, passes: n('aoPasses', 2), glossaryOverride: $('#aoGloss').value },
      ai: { baseURL: $('#aiUrl').value.trim(), apiKey: $('#aiKey').value.trim(), model: $('#aiModel').value, concurrency: n('aoConc', 8), batchChars: n('aoBatch', 6000), batchSegs: n('aoSegs', 60), segLen: n('aoSegLen', 900), temperature: $('#aoTemp').value === '' ? null : Number($('#aoTemp').value), maxTokens: Number($('#aoMax').value) || 0 },
    };
    try {
      const r = await fetch('/api/ai/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      Object.assign(J, { id: j.id, since: 0, running: true });
      $('#aiLog').innerHTML = ''; $('#aiRes').classList.add('hidden'); $('#aiRun').classList.remove('hidden');
      $('#aiStop').classList.remove('hidden'); refresh();
      poll();
    } catch (e) { $('#aiMsg').textContent = 'Lỗi: ' + e.message; }
  };
  $('#aiStop').onclick = () => J.id && fetch(`/api/ai/job/${J.id}/cancel`, { method: 'POST' });
  $('#aiOnlyWarn').onchange = () => $('#aiLog').classList.toggle('onlywarn', $('#aiOnlyWarn').checked);
  $('#aiLog').classList.toggle('onlywarn', $('#aiOnlyWarn').checked);

  async function poll() {
    clearTimeout(J.timer);
    let st;
    try {
      const r = await fetch(`/api/ai/job/${J.id}?since=${J.since}`);
      st = await r.json();
      if (!r.ok) throw new Error(st.error);
    } catch (e) { $('#aiPhase').textContent = 'Mất kết nối: ' + e.message; J.running = false; refresh(); return; }
    J.since = st.logTotal;
    const box = $('#aiLog');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.insertAdjacentHTML('beforeend', st.log.map((l) => `<div class="${l.level}">${new Date(l.t).toLocaleTimeString()} ${esc(l.msg)}</div>`).join(''));
    if (atBottom) box.scrollTop = box.scrollHeight;
    const s = st.stats;
    const pct = s.batches ? Math.round(100 * s.batchesDone / s.batches) : 0;
    $('#aiPhase').textContent = (st.pass > 1 ? `Vòng ${st.pass} · ` : '') + st.phase + (st.state === 'running' && s.batches ? ` — ${pct}%` : '');
    $('#aiTime').textContent = `${Math.round(st.elapsed)} giây`;
    $('#aiBar').style.width = (st.state === 'done' ? 100 : pct) + '%';
    const chip = (t) => `<span>${t}</span>`;
    $('#aiStats').innerHTML = [
      chip(`Lượt gọi API: ${s.calls}`), chip(`Token: ${s.promptTokens.toLocaleString()} vào / ${s.completionTokens.toLocaleString()} ra`),
      chip(`Đoạn: ${s.segsOk}/${s.segs} ổn · ${s.segsFail} giữ nguyên · ${s.segsReverted} hoàn tác`), chip(`Trường dựng lại từ RAW: ${s.rebuilt}`),
      s.errors ? `<span class="pill error">${s.errors} lỗi API</span>` : '',
      st.before ? chip(`Trước: <b>${st.before.error}</b> lỗi · ${st.before.warn} cảnh báo`) : '',
      st.after ? `<span class="pill ${st.after.error ? 'warn' : 'ok'}">Sau: ${st.after.error} lỗi · ${st.after.warn} cảnh báo</span>` : '',
    ].join('');
    if (st.state === 'running') { J.timer = setTimeout(poll, 1000); return; }
    J.running = false; $('#aiStop').classList.add('hidden'); refresh();
    $('#aiPhase').textContent = { done: 'Hoàn tất ✓', cancelled: 'Đã dừng', error: 'Lỗi — xem nhật ký' }[st.state] || st.state;
    if (st.hasResult) $('#aiRes').classList.remove('hidden');
  }

  const outName = () => {
    const b = (S.trans && mode() === 'fix' ? S.trans.name : S.raw.name).replace(/\.json$/i, '');
    return b + (mode() === 'fix' ? '.ai-fixed.json' : '.ai-vi.json');
  };
  const getResult = async () => { const r = await fetch(`/api/ai/job/${J.id}/result`); if (!r.ok) throw new Error((await r.json()).error); return r.text(); };
  const download = (name, text, type = 'application/json') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  $('#aiDownload').onclick = async () => { try { download(outName(), await getResult()); } catch (e) { alert(e.message); } };
  $('#aiUse').onclick = async () => {
    try {
      const text = await getResult();
      S.trans = { name: outName(), text, obj: JSON.parse(text) };
      refreshDrops();
      document.querySelector('input[name=aiMode][value=fix]').checked = true; save(); refresh();
      await analyze();
      $('#result').scrollIntoView({ behavior: 'smooth' });
    } catch (e) { alert(e.message); }
  };
  $('#aiGlossDl').onclick = async () => {
    const r = await fetch(`/api/ai/job/${J.id}/result?glossary=1`); const j = await r.json();
    download('tu-dien.txt', (j.glossary || []).map(([a, b]) => `${a} = ${b}`).join('\n'), 'text/plain');
  };
  refresh();
})();
