'use strict';
// Máy chủ cục bộ: phục vụ giao diện web + API phân tích / sửa / cập nhật.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze } = require('./lib/analyzer');
const { applyFixes, detectIndent } = require('./lib/fixer');
const updater = require('./lib/updater');
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
