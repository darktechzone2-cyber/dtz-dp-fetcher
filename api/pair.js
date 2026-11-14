// POST /api/pair { number } — request an 8-digit WhatsApp pairing code for
// the OWNER's own number and return it immediately.
//
// The code must reach the owner within seconds, but the socket has to stay
// alive ~42s while they type it into WhatsApp. The old design held the HTTP
// stream open for that wait — but on a phone the browser tab is backgrounded
// the moment the owner switches to WhatsApp, the stream breaks, Vercel kills
// the function, and the socket (and the code) dies with it. That is exactly
// the "Server error" the first live attempts showed. So this handler replies
// with {"ok":true,"code":"ABCD-1234"} at once, and keeps the socket waiting
// in the background with waitUntil. The web UI polls /api/status for the
// result; a later GET /api/status with registered:true means it worked.
//
// The code is requested ONLY after the socket proves it is connected:
// requestPairingCode() makes the 8-char code up locally and only registers
// it by sending companion_hello to the server. Before the handshake has
// produced a qr that send goes nowhere — the phone gets no "Enter code"
// notification and rejects the code as if it were random. If the handshake
// never completes, the handler fails honestly instead of issuing a dead
// code. A code issued moments ago for the same number is handed back
// unchanged, because two live codes for one number conflict on WhatsApp's
// side.

import { BufferJSON } from '@whiskeysockets/baileys';
import { kvConfigFromEnv, createKvClient, CREDS_KEY, PAIR_CODE_KEY } from '../lib/kv.js';
import { clearAuth } from '../lib/auth.js';
import { openSession, defaultLogger, defaultGetVersion } from '../lib/whatsapp.js';
import { normalizeNumber, maskNumber, readJsonBody, clientIp, rateLimited, sendJson } from '../lib/util.js';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';

const pairHits = new Map();

export function createPairHandler(deps = {}) {
  const makeSocket = deps.makeSocket;
  const getVersion = deps.getVersion;
  const logger = deps.logger || defaultLogger();
  const connectTimeoutMs = deps.connectTimeoutMs ?? 10000; // handshake (qr) wait before asking for a code
  const waitMs = deps.waitMs ?? 40000;          // how long to wait for the owner to enter the code
  const waitUntilFn = deps.waitUntil || vercelWaitUntil;

  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed. Use POST.' });
      return;
    }
    if (rateLimited(pairHits, clientIp(req), 6, 10 * 60_000)) {
      sendJson(res, 429, { ok: false, error: 'Too many pairing attempts. Wait a few minutes.' });
      return;
    }
    const body = await readJsonBody(req);
    const digits = normalizeNumber(body && body.number);
    if (!digits) {
      sendJson(res, 400, { ok: false, error: 'Enter a valid WhatsApp number with country code (10–15 digits, e.g. 923001234567).' });
      return;
    }

    let kv;
    try {
      kv = deps.kv || createKvClient(kvConfigFromEnv());
    } catch {
      sendJson(res, 500, { ok: false, error: 'Server storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.' });
      return;
    }

    // 1. Already paired? Read the stored creds directly — no socket needed.
    let alreadyRegistered = false;
    try {
      const raw = await kv.get(CREDS_KEY);
      if (raw) alreadyRegistered = !!JSON.parse(raw, BufferJSON.reviver).registered;
    } catch { alreadyRegistered = false; }
    if (alreadyRegistered) {
      sendJson(res, 200, { ok: true, alreadyPaired: true });
      return;
    }

    // 2. A code issued moments ago for this number is still live: hand back
    // the SAME code. A second live code for one number conflicts with the
    // first on WhatsApp's side (the phone can only complete one of them).
    try {
      const markerRaw = await kv.get(PAIR_CODE_KEY);
      if (markerRaw) {
        const marker = JSON.parse(markerRaw);
        if (marker && marker.number === digits && marker.code && Date.now() - (marker.at || 0) < 60_000) {
          sendJson(res, 200, { ok: true, code: marker.code, reused: true });
          return;
        }
      }
    } catch { /* no usable marker: proceed */ }

    // 3. Open a socket. A failed attempt leaves unregistered creds behind;
    // WhatsApp kills a re-used dead session with 401 loggedOut, and the
    // handler then saves those dead creds back — so every retry fails the
    // same way. Start from blank creds when a stale session is stored.
    let session;
    try {
      session = await openSession({ kv, makeSocket, getVersion, logger });
    } catch {
      sendJson(res, 502, { ok: false, error: 'Could not start a WhatsApp connection. Try again.' });
      return;
    }
    if (session.hadStored) {
      session.disconnect();
      await clearAuth(kv).catch(() => {});
      try {
        session = await openSession({ kv, makeSocket, getVersion, logger });
      } catch {
        sendJson(res, 502, { ok: false, error: 'Could not start a WhatsApp connection. Try again.' });
        return;
      }
    }

    // 4. Gate: only ask for the code once the server has answered the
    // handshake with pairing refs (a qr). Before this point
    // requestPairingCode() returns a code that was never registered, the
    // phone gets no notification, and the code is dead on arrival.
    try {
      await session.waitForConnectable(connectTimeoutMs);
    } catch {
      session.disconnect();
      sendJson(res, 502, { ok: false, error: 'Could not connect to WhatsApp. Try again in a moment.' });
      return;
    }

    let code;
    try {
      code = await session.sock.requestPairingCode(digits);
    } catch {
      await session.persist().catch(() => {});
      session.disconnect();
      sendJson(res, 502, { ok: false, error: 'Could not request a pairing code for that number. Check the number and try again.' });
      return;
    }
    await kv.set(PAIR_CODE_KEY, JSON.stringify({ code, number: digits, at: Date.now() })).catch(() => {});
    console.log('pair code issued for', maskNumber(digits));

    // Reply NOW; keep the socket waiting in the background with waitUntil
    // (see the header comment for why the stream must not be held open).
    const settlePair = (async () => {
      try {
        const result = await session.waitForOpen(waitMs);
        if (result === 'open' || result === 'restarted') {
          await session.persist().catch(() => {});
          console.log('pair completed for', maskNumber(digits));
        }
      } catch (e) {
        if (e.message === 'loggedOut') {
          // Dead session: remove it so the next attempt starts fresh.
          await clearAuth(kv).catch(() => {});
        }
      } finally {
        session.disconnect();
      }
    })();
    try { waitUntilFn(settlePair); } catch { /* not on Vercel: promise still runs */ }

    sendJson(res, 200, { ok: true, code });
  };
}

export default createPairHandler();
