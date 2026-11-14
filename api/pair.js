// POST /api/pair { number } — request an 8-digit WhatsApp pairing code for
// the OWNER's own number, then wait (streaming) for the owner to enter it.
//
// Why streaming: the code must be shown to the owner within seconds, but the
// socket has to stay alive while they type it into WhatsApp. So the handler
// writes the code as the FIRST JSON line immediately, keeps the socket open
// for ~42s, then writes a second JSON line with the result and ends.
// A plain client sees two JSON lines; the web UI reads them as they arrive.
//
// Response lines:
//   {"ok":true,"code":"ABCD-1234"}            — enter this in WhatsApp now
//   {"ok":true,"paired":true}                 — done, session saved in KV
//   {"ok":true,"paired":false,"error":"..."}  — code expired, request a new one

import { kvConfigFromEnv, createKvClient } from '../lib/kv.js';
import { clearAuth } from '../lib/auth.js';
import { openSession, defaultLogger, defaultGetVersion } from '../lib/whatsapp.js';
import { normalizeNumber, maskNumber, readJsonBody, clientIp, rateLimited, sleep, sendJson } from '../lib/util.js';

const pairHits = new Map();

export function createPairHandler(deps = {}) {
  const makeSocket = deps.makeSocket;
  const getVersion = deps.getVersion;
  const logger = deps.logger || defaultLogger();
  const settleMs = deps.settleMs ?? 1500;       // socket settle before requesting the code
  const waitMs = deps.waitMs ?? 42000;          // how long to wait for the owner to enter the code

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

    let session;
    try {
      session = await openSession({ kv, makeSocket, getVersion, logger });
    } catch {
      sendJson(res, 502, { ok: false, error: 'Could not start a WhatsApp connection. Try again.' });
      return;
    }

    if (session.creds.registered) {
      session.disconnect();
      sendJson(res, 200, { ok: true, alreadyPaired: true });
      return;
    }

    // A failed attempt leaves unregistered creds behind; WhatsApp kills a
    // re-used dead session with 401 loggedOut, and the handler then saves
    // those dead creds back — so every retry fails the same way. Start
    // every pairing from blank creds when a stale session is stored.
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

    // Same settle delay as the proven Node pair site before asking for a code.
    await sleep(settleMs);

    let code;
    try {
      code = await session.sock.requestPairingCode(digits);
    } catch {
      await session.persist().catch(() => {});
      session.disconnect();
      sendJson(res, 502, { ok: false, error: 'Could not request a pairing code for that number. Check the number and try again.' });
      return;
    }
    console.log('pair code issued for', maskNumber(digits));

    // Stream the code now; the owner has ~42s to enter it in WhatsApp.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.write(JSON.stringify({ ok: true, code }) + '\n');

    let paired = false;
    let waitError = null;
    try {
      const result = await session.waitForOpen(waitMs);
      paired = result === 'open' || result === 'restarted';
    } catch (e) {
      waitError = e.message;
    }
    await session.persist().catch(() => {});
    session.disconnect();

    if (paired) {
      console.log('pair completed for', maskNumber(digits));
      res.write(JSON.stringify({ ok: true, paired: true }) + '\n');
    } else {
      if (waitError === 'loggedOut') {
        // Dead session: remove it so the next attempt starts fresh.
        await clearAuth(kv).catch(() => {});
      }
      res.write(JSON.stringify({
        ok: true,
        paired: false,
        error: waitError === 'loggedOut'
          ? 'WhatsApp logged the session out. Request a new code.'
          : 'Pairing timed out. The code has expired — request a new one and enter it in WhatsApp within about 45 seconds.',
      }) + '\n');
    }
    res.end();
  };
}

export default createPairHandler();
