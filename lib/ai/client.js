'use strict';
// Gọi API dạng OpenAI (chat/completions, models) — dùng được với mọi provider tương thích OpenAI.

function normBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/(chat\/completions|completions|models)$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function headers(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = 'Bearer ' + apiKey;
  return h;
}

async function fetchJson(url, init, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('Hết thời gian chờ (' + Math.round(timeoutMs / 1000) + 's)')), timeoutMs);
  if (init && init.signal) init.signal.addEventListener('abort', () => ac.abort(init.signal.reason), { once: true });
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* không phải JSON */ }
    if (!r.ok) {
      const msg = (j && (j.error?.message || j.error || j.message)) || text.slice(0, 300) || r.statusText;
      const e = new Error(`HTTP ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      e.status = r.status;
      e.retryAfter = Number(r.headers.get('retry-after')) || 0;
      throw e;
    }
    if (!j) throw new Error('Phản hồi không phải JSON: ' + text.slice(0, 200));
    return j;
  } finally { clearTimeout(t); }
}

// Lấy danh sách model. Tự thử thêm /v1 nếu URL người dùng nhập thiếu.
async function listModels(baseURL, apiKey) {
  const base = normBase(baseURL);
  const tries = [base];
  if (!/\/v\d+[a-z]*$/i.test(base)) tries.push(base + '/v1');
  let lastErr;
  for (const b of tries) {
    try {
      const j = await fetchJson(b + '/models', { headers: headers(apiKey) }, 30000);
      const arr = Array.isArray(j) ? j : (j.data || j.models || []);
      const ids = arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).map((s) => s.replace(/^models\//, ''));
      return { baseURL: b, models: [...new Set(ids)].sort() };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errText(status, text, j) {
  let msg = (j && (j.error?.message || j.error || j.message)) || text || '';
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  if (/<html|<!DOCTYPE/i.test(msg)) msg = status === 524 ? 'Cloudflare hết thời gian chờ (524)' : (msg.match(/<title>([^<]*)/i) || [])[1] || 'trang lỗi HTML';
  return `HTTP ${status}: ${msg.slice(0, 300)}`;
}

// Gọi 1 lần, dạng streaming (SSE) để kết nối không bị proxy/Cloudflare cắt khi model trả lời lâu.
async function chatOnce(cfg, body) {
  const ac = new AbortController();
  const idleMs = cfg.idleMs || 180000;
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error(`Không nhận được dữ liệu trong ${idleMs / 1000}s`)), idleMs); };
  const onAbort = () => ac.abort(cfg.signal.reason);
  if (cfg.signal) cfg.signal.addEventListener('abort', onAbort, { once: true });
  arm();
  try {
    const r = await fetch(normBase(cfg.baseURL) + '/chat/completions', { method: 'POST', headers: headers(cfg.apiKey), body: JSON.stringify(body), signal: ac.signal });
    if (!r.ok) {
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (_) { /* */ }
      const e = new Error(errText(r.status, text, j));
      e.status = r.status; e.retryAfter = Number(r.headers.get('retry-after')) || 0;
      throw e;
    }
    const ct = r.headers.get('content-type') || '';
    if (!/event-stream/.test(ct)) {
      // provider không hỗ trợ stream → JSON thường
      const text = await r.text();
      const j = JSON.parse(text);
      const ch = j.choices && j.choices[0];
      let content = ch?.message?.content ?? ch?.text ?? '';
      if (Array.isArray(content)) content = content.map((p) => p.text || '').join('');
      return { content: String(content), usage: j.usage || null, finish: ch?.finish_reason };
    }
    let content = '', usage = null, finish = null, buf = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      arm();
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (_) { continue; }
        if (j.error) { const e = new Error(errText(j.error.code || 500, '', j)); e.status = Number(j.error.code) || 500; throw e; }
        const ch = j.choices && j.choices[0];
        const d = ch?.delta?.content ?? ch?.message?.content ?? ch?.text;
        if (d) content += Array.isArray(d) ? d.map((p) => p.text || '').join('') : d;
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (j.usage) usage = j.usage;
      }
    }
    if (!content && !finish) { const e = new Error('Phản hồi rỗng'); e.status = 502; throw e; }
    return { content, usage, finish };
  } finally {
    clearTimeout(timer);
    if (cfg.signal) cfg.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Gọi chat/completions có thử lại khi 429/5xx/lỗi mạng.
 * cfg: { baseURL, apiKey, model, temperature, maxTokens, retries, signal, onRetry, stream }
 */
async function chat(cfg, messages) {
  const body = { model: cfg.model, messages, stream: cfg.stream !== false };
  if (body.stream) body.stream_options = { include_usage: true };
  if (cfg.temperature != null && cfg.temperature !== '') body.temperature = Number(cfg.temperature);
  if (cfg.maxTokens) body.max_tokens = Number(cfg.maxTokens);
  const retries = cfg.retries ?? 1000;
  let attempt = 0;
  for (;;) {
    if (cfg.signal?.aborted) throw new Error('Đã dừng');
    try {
      const r = await chatOnce(cfg, body);
      r.content = r.content.replace(/<think>[\s\S]*?<\/think>/g, '');
      return r;
    } catch (e) {
      if (cfg.signal?.aborted) throw new Error('Đã dừng');
      // provider không nhận stream_options → bỏ đi rồi thử lại ngay
      if (e.status === 400 && body.stream_options && /stream_options|include_usage/i.test(e.message)) { delete body.stream_options; continue; }
      // 429 / 5xx / lỗi mạng / hết giờ: cứ thử lại (người dùng có thể đổi tài khoản phía provider trong lúc chạy)
      const retryable = !e.status || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= retries) throw e;
      attempt++;
      const wait = Math.min(15000, e.retryAfter ? e.retryAfter * 1000 : 1000 * 2 ** Math.min(attempt, 4)) + Math.random() * 1000;
      if (cfg.onRetry) cfg.onRetry(e, attempt, wait);
      await sleep(wait);
    }
  }
}

module.exports = { listModels, chat, normBase };
