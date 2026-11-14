// POST /api/fetch { number } — download one WhatsApp profile photo in full
// quality. Each call reconnects to WhatsApp from the KV session (serverless
// has no live socket), so expect 15–30 seconds. Disconnects when done.
//
// Responses:
//   200 { ok:true, number, url }   — full-quality photo URL (WhatsApp CDN)
//   404 { ok:false, error }        — no photo visible for this number (honest:
//                                    no photo, or privacy hides it from you)
//   503 { ok:false, error }        — WhatsApp not paired yet, or did not connect

import { BufferJSON } from '@whiskeysockets/baileys';
import { kvConfigFromEnv, createKvClient, CREDS_KEY } from '../lib/kv.js';
import { connectWhatsApp, defaultLogger, defaultGetVersion } from '../lib/whatsapp.js';
import { normalizeNumber, isWhatsappCdn, readJsonBody, clientIp, rateLimited, sendJson } from '../lib/util.js';

const fetchHits = new Map();

export function createFetchHandler(deps = {}) {
  const makeSocket = deps.makeSocket;
  const getVersion = deps.getVersion;
  const logger = deps.logger || defaultLogger();
  const openTimeoutMs = deps.openTimeoutMs ?? 35000;

  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed. Use POST.' });
      return;
    }
    if (rateLimited(fetchHits, clientIp(req), 20, 60_000)) {
      sendJson(res, 429, { ok: false, error: 'Too many lookups. Wait a minute.' });
      return;
    }
    const body = await readJsonBody(req);
    const digits = normalizeNumber(body && body.number);
    if (!digits) {
      sendJson(res, 400, { ok: false, error: 'Enter a valid WhatsApp number with country code (10–15 digits).' });
      return;
    }

    let kv;
    try {
      kv = deps.kv || createKvClient(kvConfigFromEnv());
    } catch {
      sendJson(res, 500, { ok: false, error: 'Server storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.' });
      return;
    }

    // Fast path: no paired session in KV means no point opening a socket.
    let registered = false;
    try {
      const raw = await kv.get(CREDS_KEY);
      if (raw) registered = !!JSON.parse(raw, BufferJSON.reviver).registered;
    } catch { registered = false; }
    if (!registered) {
      sendJson(res, 503, { ok: false, error: 'WhatsApp is not paired yet. Pair your number first (Step 1 on the home page).' });
      return;
    }

    let session;
    try {
      session = await connectWhatsApp({ kv, makeSocket, getVersion, logger }, { openTimeoutMs });
    } catch (e) {
      const msg = e.message === 'loggedOut'
        ? 'WhatsApp logged the session out. Pair your number again.'
        : 'WhatsApp did not connect in time. Try again.';
      sendJson(res, 503, { ok: false, error: msg });
      return;
    }

    const jid = digits + '@s.whatsapp.net';
    try {
      const url = await session.sock.profilePictureUrl(jid, 'image');
      if (!url || !isWhatsappCdn(url)) throw new Error('bad-url');
      await session.persist().catch(() => {});
      sendJson(res, 200, { ok: true, number: digits, url });
    } catch {
      sendJson(res, 404, { ok: false, error: 'No profile photo visible for this number. It may have no photo, or its privacy is set so only contacts can see it.' });
    } finally {
      await session.persist().catch(() => {});
      session.disconnect();
    }
  };
}

export default createFetchHandler();
