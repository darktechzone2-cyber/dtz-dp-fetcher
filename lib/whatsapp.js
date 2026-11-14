// Baileys socket sessions for serverless: open a fresh connection per
// invocation, wait for it, do the one job, disconnect. Nothing is kept in
// memory between invocations — the session lives in KV (see lib/auth.js).

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { loadAuth } from './auth.js';

const silentLogger = pino({ level: 'silent' });

export function defaultLogger() { return silentLogger; }

export async function defaultGetVersion() {
  try {
    return await fetchLatestBaileysVersion();
  } catch {
    return { version: [2, 3000, 0] };
  }
}

/**
 * Create one Baileys socket from the KV session. Returns a session object:
 *   { sock, creds, persist, waitForOpen(timeoutMs), disconnect }
 * waitForOpen resolves 'open', or 'restarted' when WhatsApp closes the
 * socket with restartRequired AFTER registering the creds (a normal
 * post-pairing close). It throws 'timeout' | 'loggedOut' | 'closed'.
 * waitForConnectable resolves once the server has answered the handshake
 * with pairing refs (a connection.update carrying a qr). It throws
 * 'connect-timeout' | 'loggedOut' | 'closed'.
 */
export async function openSession(deps = {}) {
  const kv = deps.kv;
  const makeSocket = deps.makeSocket || makeWASocket;
  const getVersion = deps.getVersion || defaultGetVersion;
  const logger = deps.logger || silentLogger;

  const { creds, keys, persist, hadStored } = await loadAuth(kv, logger);
  const { version } = await getVersion();
  const sock = makeSocket({
    version,
    logger,
    auth: { creds, keys },
    printQRInTerminal: false,
    browser: ['DTZ DP Fetcher', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Persist on every credential change, so a killed invocation still
  // leaves a usable session in KV.
  sock.ev.on('creds.update', () => { persist().catch(() => {}); });

  function disconnect() {
    try { sock.end?.(); } catch { /* ignore */ }
    try { sock.ws?.close?.(); } catch { /* ignore */ }
  }

  function waitForOpen(timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('timeout'));
      }, timeoutMs);
      const onUpdate = (u) => {
        if (done) return;
        if (u.connection === 'open') {
          done = true;
          cleanup();
          resolve('open');
          return;
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.restartRequired && creds.registered) {
            done = true;
            cleanup();
            resolve('restarted');
            return;
          }
          if (code === DisconnectReason.loggedOut) {
            done = true;
            cleanup();
            reject(new Error('loggedOut'));
            return;
          }
          done = true;
          cleanup();
          reject(new Error('closed'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        try { sock.ev.off?.('connection.update', onUpdate); } catch { /* ignore */ }
      };
      sock.ev.on('connection.update', onUpdate);
    });
  }

  // Resolves once the server has answered the handshake with pairing refs
  // (a connection.update carrying a qr). That is the only proof this
  // socket can register a pairing code: requestPairingCode() makes the
  // 8-char code up LOCALLY and only registers it by sending companion_hello
  // to the server. Before the handshake completes that send goes nowhere,
  // so the phone gets no "Enter code" notification and rejects the code
  // as if it were random. Note: connection 'connecting' alone is NOT a
  // gate — Baileys emits it on nextTick before the server answers.
  function waitForConnectable(timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('connect-timeout'));
      }, timeoutMs);
      const onUpdate = (u) => {
        if (done) return;
        if (u.qr || u.connection === 'open') {
          done = true;
          cleanup();
          resolve('connectable');
          return;
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          done = true;
          cleanup();
          reject(new Error(code === DisconnectReason.loggedOut ? 'loggedOut' : 'closed'));
          return;
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        try { sock.ev.off?.('connection.update', onUpdate); } catch { /* ignore */ }
      };
      sock.ev.on('connection.update', onUpdate);
    });
  }

  return { sock, creds, persist, waitForOpen, waitForConnectable, disconnect, hadStored };
}

/**
 * Open a socket and wait for it, retrying once when WhatsApp answers with
 * restartRequired (the session is registered; a fresh socket is needed).
 * Returns the session, or throws 'timeout' | 'loggedOut' | 'closed'.
 */
export async function connectWhatsApp(deps = {}, { openTimeoutMs = 35000, maxAttempts = 2 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = await openSession(deps);
    try {
      const result = await session.waitForOpen(openTimeoutMs);
      if (result === 'restarted') {
        // Session is registered but this socket was closed; reconnect fresh.
        await session.persist().catch(() => {});
        session.disconnect();
        if (attempt < maxAttempts) continue;
        throw new Error('closed');
      }
      return session;
    } catch (e) {
      lastError = e;
      session.disconnect();
      throw e;
    }
  }
  throw lastError || new Error('closed');
}
