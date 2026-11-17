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

/**
 * Gọi chat/completions có thử lại khi 429/5xx/lỗi mạng.
 * cfg: { baseURL, apiKey, model, temperature, maxTokens, timeoutMs, retries, signal }
 */
async function chat(cfg, messages) {
  const body = { model: cfg.model, messages, stream: false };
  if (cfg.temperature != null && cfg.temperature !== '') body.temperature = Number(cfg.temperature);
  if (cfg.maxTokens) body.max_tokens = Number(cfg.maxTokens);
  const retries = cfg.retries ?? 5;
  let attempt = 0;
  for (;;) {
    if (cfg.signal?.aborted) throw new Error('Đã dừng');
    try {
      const j = await fetchJson(normBase(cfg.baseURL) + '/chat/completions', { method: 'POST', headers: headers(cfg.apiKey), body: JSON.stringify(body), signal: cfg.signal }, cfg.timeoutMs || 240000);
      const ch = j.choices && j.choices[0];
      let content = ch?.message?.content ?? ch?.text ?? '';
      if (Array.isArray(content)) content = content.map((p) => p.text || '').join('');
      content = String(content).replace(/<think>[\s\S]*?<\/think>/g, '');
      return { content, usage: j.usage || null, finish: ch?.finish_reason };
    } catch (e) {
      if (cfg.signal?.aborted) throw new Error('Đã dừng');
      const retryable = !e.status || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= retries) throw e;
      attempt++;
      const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(60000, 1500 * 2 ** attempt) + Math.random() * 1000;
      if (cfg.onRetry) cfg.onRetry(e, attempt, wait);
      await sleep(wait);
    }
  }
}

module.exports = { listModels, chat, normBase };
