// Shared helpers for the DTZ DP Fetcher (Vercel serverless version).

/** "923001234567" out of "+92 300 1234567", "00923001234567", "92 300..." — else null. */
export function normalizeNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d{10,15}$/.test(digits)) return null;
  return digits;
}

export function maskNumber(num) {
  const s = String(num);
  return s.slice(0, 3) + '***' + s.slice(-2);
}

/** Only WhatsApp/Facebook CDN hosts may be trusted as photo URLs. */
export function isWhatsappCdn(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('.whatsapp.net') || host === 'whatsapp.net' ||
      host.endsWith('.fbcdn.net') || host === 'fbcdn.net';
  } catch { return false; }
}

export function clientIp(req) {
  const fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Tiny in-memory rate limiter. store is a Map. Returns true when over the limit. */
export function rateLimited(store, key, max, windowMs) {
  const now = Date.now();
  const hits = (store.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  store.set(key, hits);
  return hits.length > max;
}

/** Parse a JSON request body. Vercel usually parses it already; this covers raw streams too. */
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (typeof req.body === 'object') return req.body;
  }
  if (typeof req.on === 'function') {
    const chunks = [];
    await new Promise((resolve) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', resolve);
      req.on('error', resolve);
    });
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
  }
  return {};
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Send a JSON response using only plain http primitives (no framework sugar). */
export function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
