'use strict';
// Tự cập nhật từ GitHub: so sánh commit SHA đang cài với commit mới nhất trên nhánh chính.
// - Nếu thư mục là git clone và có lệnh git: dùng `git pull --ff-only`.
// - Nếu không (tải ZIP): tải từng file qua raw.githubusercontent.com theo đúng SHA rồi ghi đè.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config.json');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.install.json');
const UA = { 'User-Agent': 'st-card-checker-updater', Accept: 'application/vnd.github+json' };
// Không bao giờ ghi đè các file này khi cập nhật
const PROTECTED = new Set(['config.local.json', '.install.json']);

const state = { checking: false, lastCheck: null, current: null, latest: null, hasUpdate: false, message: '', error: null, mode: null, applying: false };

function sh(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { cwd: ROOT, timeout: 120000 }, (err, so, se) => resolve({ ok: !err, out: String(so || '').trim(), err: String(se || (err && err.message) || '').trim() })));
}

async function isGitRepo() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return false;
  const r = await sh('git', ['rev-parse', 'HEAD']);
  return r.ok ? r.out : false;
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function currentSha() {
  const g = await isGitRepo();
  if (g) { state.mode = 'git'; return g; }
  state.mode = 'zip';
  return readState().sha || null;
}

async function gh(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`GitHub trả về ${r.status} cho ${url}`);
  return r.json();
}

async function check() {
  if (state.checking) return state;
  state.checking = true;
  try {
    const { owner, repo, branch } = config.github;
    const c = await gh(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`);
    state.latest = c.sha;
    state.latestDate = c.commit && c.commit.committer && c.commit.committer.date;
    state.message = (c.commit && c.commit.message) || '';
    state.current = await currentSha();
    state.hasUpdate = !!state.latest && state.latest !== state.current;
    // nếu là git: chỉ báo có cập nhật khi commit mới không phải là tổ tiên của HEAD
    if (state.mode === 'git' && state.hasUpdate) {
      await sh('git', ['fetch', '--quiet', 'origin', branch]);
      const anc = await sh('git', ['merge-base', '--is-ancestor', state.latest, 'HEAD']);
      if (anc.ok) state.hasUpdate = false;
    }
    try {
      const pkg = await (await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${state.latest}/package.json`, { headers: { 'User-Agent': UA['User-Agent'] } })).json();
      state.latestVersion = pkg.version;
    } catch (_) { /* bỏ qua */ }
    state.error = null;
  } catch (e) {
    state.error = e.message;
  } finally {
    state.checking = false;
    state.lastCheck = new Date().toISOString();
  }
  return state;
}

async function apply() {
  if (state.applying) throw new Error('Đang cập nhật…');
  state.applying = true;
  try {
    if (!state.latest) await check();
    const { owner, repo, branch } = config.github;
    if (await isGitRepo()) {
      const r = await sh('git', ['pull', '--ff-only', 'origin', branch]);
      if (!r.ok) throw new Error('git pull thất bại: ' + r.err);
      return { ok: true, mode: 'git', detail: r.out };
    }
    const sha = state.latest;
    const tree = await gh(`https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const files = tree.tree.filter((t) => t.type === 'blob' && !PROTECTED.has(t.path));
    const tmp = path.join(ROOT, '.update-tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of files) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] } });
      if (!r.ok) throw new Error(`Tải ${f.path} thất bại (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      const dest = path.join(tmp, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    // tải xong toàn bộ mới ghi đè (tránh hỏng giữa chừng)
    for (const f of files) {
      const dest = path.join(ROOT, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(tmp, f.path), dest);
      if (/\.(sh|command)$/.test(f.path)) { try { fs.chmodSync(dest, 0o755); } catch (_) {} }
    }
    // xoá file cũ do bản trước cài mà bản mới không còn
    const prev = readState().files || [];
    const now = new Set(files.map((f) => f.path));
    for (const p of prev) if (!now.has(p) && !PROTECTED.has(p)) { try { fs.unlinkSync(path.join(ROOT, p)); } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
    writeState({ sha, files: [...now], updatedAt: new Date().toISOString() });
    return { ok: true, mode: 'zip', count: files.length };
  } finally {
    state.applying = false;
  }
}

module.exports = { check, apply, state };
