'use strict';
// Máy chủ cục bộ: phục vụ giao diện web + API phân tích / sửa / cập nhật.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze } = require('./lib/analyzer');
const { applyFixes, detectIndent } = require('./lib/fixer');
const updater = require('./lib/updater');
const aiClient = require('./lib/ai/client');
const aiPipeline = require('./lib/ai/pipeline');
const config = require('./config.json');
const pkg = require('./package.json');

const PUBLIC = path.join(__dirname, 'public');
const RESTART_CODE = 42;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseCard(text, label) {
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`${label}: JSON không hợp lệ — ${e.message}`); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/version') {
      return send(res, 200, { version: pkg.version, pid: process.pid, update: publicState() });
    }
    if (req.method === 'GET' && url.pathname === '/api/update/status') return send(res, 200, publicState());
    if (req.method === 'POST' && url.pathname === '/api/update/check') { await updater.check(); return send(res, 200, publicState()); }
    if (req.method === 'POST' && url.pathname === '/api/update/apply') {
      const r = await updater.apply();
      send(res, 200, { ...r, restarting: true });
      setTimeout(() => process.exit(RESTART_CODE), 300);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = JSON.parse(await readBody(req));
      const raw = parseCard(body.raw, 'File RAW');
      const trans = parseCard(body.trans, 'File DỊCH');
      const t0 = Date.now();
      const report = await analyze(raw, trans, body.options || {});
      report.meta.ms = Date.now() - t0;
      return send(res, 200, report);
    }
    if (req.method === 'POST' && url.pathname === '/api/fix') {
      const body = JSON.parse(await readBody(req));
      const trans = parseCard(body.trans, 'File DỊCH');
      const opts = body.options || {};
      if (opts.glossary && Array.isArray(body.glossary)) opts.glossaryMap = new Map(body.glossary);
      const { card, log } = applyFixes(trans, opts);
      const indent = detectIndent(body.trans);
      return send(res, 200, { text: JSON.stringify(card, null, indent), log });
    }
    // ----- AI -----
    if (req.method === 'POST' && url.pathname === '/api/ai/models') {
      const body = JSON.parse(await readBody(req));
      if (!body.baseURL) return send(res, 400, { error: 'Chưa nhập URL API' });
      return send(res, 200, await aiClient.listModels(body.baseURL, body.apiKey));
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/start') {
      const body = JSON.parse(await readBody(req));
      const mode = body.mode === 'translate' ? 'translate' : 'fix';
      parseCard(body.raw, 'File RAW');
      if (mode === 'fix') parseCard(body.trans, 'File DỊCH');
      if (!body.ai || !body.ai.baseURL || !body.ai.model) return send(res, 400, { error: 'Thiếu URL API hoặc model' });
      const job = aiPipeline.start({ rawText: body.raw, transText: body.trans, mode, options: body.options || {}, ai: body.ai });
      return send(res, 200, { id: job.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/ai/jobs') {
      return send(res, 200, [...aiPipeline.jobs.values()].map((j) => { const st = aiPipeline.status(j, Math.max(0, j.log.length - 8)); return { ...st, log: st.log.map((l) => l.msg) }; }));
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/ai\/job\/(\w+)(\/cancel|\/result)?$/))) {
      const job = aiPipeline.jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'Không tìm thấy phiên chạy (máy chủ đã khởi động lại?)' });
      if (m[2] === '/cancel' && req.method === 'POST') { job.cancel(); return send(res, 200, { ok: true }); }
      if (m[2] === '/result') {
        if (url.searchParams.get('samples')) return send(res, 200, { samples: job.samples || [] });
        if (!job.result) return send(res, 404, { error: 'Chưa có kết quả' });
        if (url.searchParams.get('glossary')) return send(res, 200, { glossary: job.glossary || [] });
        if (url.searchParams.get('samples')) return send(res, 200, { samples: job.samples || [] });
        return send(res, 200, job.result, 'application/json; charset=utf-8');
      }
      return send(res, 200, aiPipeline.status(job, Number(url.searchParams.get('since')) || 0));
    }
    // tệp tĩnh
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

function publicState() {
  const s = updater.state;
  return { current: s.current, latest: s.latest, latestVersion: s.latestVersion, hasUpdate: s.hasUpdate, message: s.message, latestDate: s.latestDate, lastCheck: s.lastCheck, error: s.error, mode: s.mode, applying: s.applying, version: pkg.version, repo: `${config.github.owner}/${config.github.repo}` };
}

function listen(port, tries = 10) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    console.error(e); process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  ST Card Checker v${pkg.version} đang chạy: ${url}\n  (Đóng cửa sổ này để tắt)\n`);
    if (process.send) process.send({ type: 'ready', url });
  });
}

async function boot() {
  const noUpdate = process.argv.includes('--no-update') || process.env.STCC_NO_UPDATE;
  if (!noUpdate) {
    await updater.check();
    const s = updater.state;
    if (s.error) console.log('  [Cập nhật] Không kiểm tra được:', s.error);
    else if (s.hasUpdate && config.autoUpdateOnStart && !process.env.STCC_JUST_UPDATED) {
      console.log(`  [Cập nhật] Có bản mới (${(s.latest || '').slice(0, 7)}): ${s.message.split('\n')[0]} → đang tải…`);
      try { await updater.apply(); console.log('  [Cập nhật] Xong, khởi động lại…'); process.exit(RESTART_CODE); } catch (e) { console.log('  [Cập nhật] Lỗi:', e.message); }
    } else if (!s.hasUpdate) console.log('  [Cập nhật] Đang dùng bản mới nhất.');
    const every = Math.max(1, Number(config.checkIntervalMinutes) || 5) * 60 * 1000;
    setInterval(() => updater.check().then((st) => { if (st.hasUpdate) console.log('  [Cập nhật] Có bản mới — bấm "Cập nhật" trên giao diện.'); }), every).unref();
  }
  listen(Number(process.env.PORT) || config.port || 4848);
}
boot();
