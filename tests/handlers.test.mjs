// Handler tests for the Vercel DP Fetcher.
// No real WhatsApp and no real Upstash: both are faked.
// The fake Baileys socket mirrors real behaviour closely enough to prove the
// flows: on 'open' it flips creds.registered and fires creds.update, like
// real Baileys does after a successful pairing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createPairHandler } from '../api/pair.js';
import { createFetchHandler } from '../api/fetch.js';
import { createStatusHandler } from '../api/status.js';
import { CREDS_KEY, KEYS_KEY, PAIR_CODE_KEY } from '../lib/kv.js';

const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

function makeFakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); return true; },
    async del(key) { store.delete(key); return true; },
  };
}

function seedUnregisteredKv(kv) {
  const creds = initAuthCreds(); // registered === false
  kv.store.set(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
  kv.store.set(KEYS_KEY, JSON.stringify({}, BufferJSON.replacer));
  return creds;
}

function seedRegisteredKv(kv) {
  const creds = initAuthCreds();
  creds.registered = true;
  kv.store.set(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
  kv.store.set(KEYS_KEY, JSON.stringify({}, BufferJSON.replacer));
  return creds;
}

// --- fake Baileys socket ----------------------------------------------------
class FakeSocket {
  constructor(opts) {
    this.capturedCreds = opts?.auth?.creds;
    this.handlers = {};
    this.ev = {
      on: (ev, fn) => { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
      off: (ev, fn) => { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); },
    };
    this.ended = false;
  }
  emit(ev, data) { for (const fn of this.handlers[ev] || []) fn(data); }
  emitConnecting() {
    this.emit('connection.update', { connection: 'connecting', qr: 'fake-qr-ref' });
  }
  emitOpen() {
    if (this.capturedCreds) this.capturedCreds.registered = true;
    this.emit('creds.update', this.capturedCreds);
    this.emit('connection.update', { connection: 'open' });
  }
  emitClose(statusCode) {
    this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode } } },
    });
  }
  async requestPairingCode(_number) { return '1234-5678'; }
  async profilePictureUrl(jid) {
    if (jid === '923001234567@s.whatsapp.net') return 'https://pps.whatsapp.net/v/t61.fake-dp.jpg';
    throw new Error('404');
  }
  end() { this.ended = true; }
  ws = { close: () => { this.ended = true; } };
}

// --- mock req/res -----------------------------------------------------------
function mockReq({ method = 'POST', body = {}, ip = '127.0.0.1' } = {}) {
  return { method, body, headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } };
}

function mockRes() {
  const chunks = [];
  let statusCode = 200;
  let body = null;
  let ended = false;
  let resolveEnd;
  const endPromise = new Promise((r) => { resolveEnd = r; });
  const res = {
    status(c) { statusCode = c; return res; },
    json(o) { body = o; res._status = statusCode; res.end(); return res; },
    setHeader() {},
    writeHead(c) { statusCode = c; },
    write(s) { chunks.push(String(s)); return true; },
    end(b) { if (b !== undefined) body = (typeof b === 'string' ? JSON.parse(b) : b); if (!ended) { ended = true; resolveEnd(); } },
    get statusCode() { return statusCode; },
    get jsonBody() { return body; },
    chunks,
    endPromise,
  };
  return res;
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 25) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const fastVersion = async () => ({ version: [2, 3000, 0] });

// --- pair ------------------------------------------------------------------
test('pair returns the code immediately and completes pairing in the background', async () => {
  const kv = makeFakeKv();
  const sockets = [];
  const bg = [];
  const handler = createPairHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    connectTimeoutMs: 5000,
    waitMs: 5000,
    waitUntil: (p) => { bg.push(p); },
  });
  const res = mockRes();
  const run = handler(mockReq({ body: { number: '+92 300 1234567' } }), res);
  // The server must answer the handshake (qr) before any code is issued.
  await waitFor(() => sockets[0]);
  sockets[0].emitConnecting();
  await run;
  await res.endPromise;

  // The code comes back in the immediate JSON reply — no stream is held.
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.code, '1234-5678');
  assert.equal(bg.length, 1, 'background wait started');

  // Owner enters the code in WhatsApp now (browser tab may be backgrounded).
  sockets[0].emitOpen();
  await bg[0];

  const savedCreds = JSON.parse(kv.store.get(CREDS_KEY), BufferJSON.reviver);
  assert.equal(savedCreds.registered, true);
  assert.ok(kv.store.has(KEYS_KEY), 'keys key written too');
});

test('pair returns a clear 502 and no code when WhatsApp never answers the handshake', async () => {
  const kv = makeFakeKv();
  const sockets = [];
  const bg = [];
  const handler = createPairHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    connectTimeoutMs: 100,
    waitMs: 5000,
    waitUntil: (p) => { bg.push(p); },
  });
  const res = mockRes();
  await handler(mockReq({ body: { number: '+92 300 1234567' }, ip: '127.0.0.2' }), res);
  await res.endPromise;

  assert.equal(res.statusCode, 502);
  assert.match(res.jsonBody.error, /Could not connect to WhatsApp/);
  assert.equal(res.jsonBody.code, undefined);
  assert.equal(bg.length, 0, 'no background wait without a real code');
});

test('pair returns the same live code for a repeat request instead of a second code', async () => {
  const kv = makeFakeKv();
  kv.store.set(PAIR_CODE_KEY, JSON.stringify({ code: 'AAAA-1111', number: '923001234567', at: Date.now() }));
  const sockets = [];
  const handler = createPairHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
  });
  const res = mockRes();
  await handler(mockReq({ body: { number: '+92 300 1234567' }, ip: '127.0.0.3' }), res);
  await res.endPromise;

  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.code, 'AAAA-1111');
  assert.equal(res.jsonBody.reused, true);
  assert.equal(sockets.length, 0, 'no socket opened for a live code');
});

test('pair rejects a bad number and returns a clear error', async () => {
  const kv = makeFakeKv();
  const handler = createPairHandler({ kv, logger: silentLogger });
  const res = mockRes();
  await handler(mockReq({ body: { number: '12' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.jsonBody.error, /valid WhatsApp number/);
});

test('pair wipes a stale unregistered session and pairs from fresh creds', async () => {
  const kv = makeFakeKv();
  const seeded = seedUnregisteredKv(kv);
  const seededJson = kv.store.get(CREDS_KEY);
  const sockets = [];
  const bg = [];
  const handler = createPairHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    connectTimeoutMs: 5000,
    waitMs: 5000,
    waitUntil: (p) => { bg.push(p); },
  });
  const res = mockRes();
  const run = handler(mockReq({ body: { number: '+92 300 1234567' } }), res);
  // First socket opened the stale session and was discarded; the live
  // socket is the second one — it must answer the handshake first.
  await waitFor(() => sockets[1]);
  sockets[1].emitConnecting();
  await run;
  await res.endPromise;

  assert.equal(res.jsonBody.code, '1234-5678');
  assert.notEqual(sockets[1].capturedCreds, seeded);
  sockets[1].emitOpen();
  await bg[0];

  const savedCreds = JSON.parse(kv.store.get(CREDS_KEY), BufferJSON.reviver);
  assert.equal(savedCreds.registered, true);
  assert.notEqual(kv.store.get(CREDS_KEY), seededJson, 'stale creds replaced, not reused');
});

test('pair wipes the dead session after WhatsApp logs it out', async () => {
  const kv = makeFakeKv();
  seedUnregisteredKv(kv);
  const sockets = [];
  const bg = [];
  const handler = createPairHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    connectTimeoutMs: 5000,
    waitMs: 5000,
    waitUntil: (p) => { bg.push(p); },
  });
  const res = mockRes();
  const run = handler(mockReq({ body: { number: '+92 300 1234567' } }), res);
  await waitFor(() => sockets[1]);
  sockets[1].emitConnecting();
  await run;
  await res.endPromise;

  assert.equal(res.jsonBody.code, '1234-5678');
  sockets[1].emitClose(401); // WhatsApp: logged out
  await bg[0];

  assert.equal(kv.store.has(CREDS_KEY), false, 'dead creds wiped');
  assert.equal(kv.store.has(KEYS_KEY), false, 'dead keys wiped');
});

test('pair reports alreadyPaired when KV already holds a registered session', async () => {
  const kv = makeFakeKv();
  seedRegisteredKv(kv);
  const handler = createPairHandler({
    kv,
    makeSocket: (opts) => new FakeSocket(opts),
    getVersion: fastVersion,
    logger: silentLogger,
  });
  const res = mockRes();
  await handler(mockReq({ body: { number: '923001234567' } }), res);
  assert.equal(res.jsonBody.alreadyPaired, true);
});

// --- fetch ------------------------------------------------------------------
test('fetch returns the full-quality photo URL when connected', async () => {
  const kv = makeFakeKv();
  seedRegisteredKv(kv);
  const sockets = [];
  const handler = createFetchHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    openTimeoutMs: 5000,
  });
  const res = mockRes();
  const run = handler(mockReq({ body: { number: '+92 300 1234567' } }), res);
  await waitFor(() => sockets[0]);
  sockets[0].emitOpen();
  await run;
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.number, '923001234567');
  assert.equal(res.jsonBody.url, 'https://pps.whatsapp.net/v/t61.fake-dp.jpg');
});

test('fetch returns an honest 404 when the photo is not visible', async () => {
  const kv = makeFakeKv();
  seedRegisteredKv(kv);
  const sockets = [];
  const handler = createFetchHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    openTimeoutMs: 5000,
  });
  const res = mockRes();
  const run = handler(mockReq({ body: { number: '923009999999' } }), res);
  await waitFor(() => sockets[0]);
  sockets[0].emitOpen();
  await run;
  assert.equal(res.statusCode, 404);
  assert.match(res.jsonBody.error, /No profile photo visible/);
});

test('fetch refuses clearly when nothing is paired yet', async () => {
  const kv = makeFakeKv(); // empty KV, no session at all
  const handler = createFetchHandler({
    kv,
    makeSocket: (opts) => new FakeSocket(opts),
    getVersion: fastVersion,
    logger: silentLogger,
  });
  const res = mockRes();
  await handler(mockReq({ body: { number: '923001234567' } }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.jsonBody.error, /not paired yet/);
});

test('fetch retries once after a restartRequired close, then succeeds', async () => {
  const kv = makeFakeKv();
  seedRegisteredKv(kv);
  const sockets = [];
  const handler = createFetchHandler({
    kv,
    makeSocket: (opts) => { const s = new FakeSocket(opts); sockets.push(s); return s; },
    getVersion: fastVersion,
    logger: silentLogger,
    openTimeoutMs: 5000,
  });
  const res = mockRes();
  const run = handler(mockReq({ body: { number: '923001234567' } }), res);
  await waitFor(() => sockets[0]);
  sockets[0].emitClose(515); // WhatsApp: restart required (session is registered)
  await waitFor(() => sockets[1]);
  sockets[1].emitOpen();
  await run;
  assert.equal(sockets.length, 2);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.url, 'https://pps.whatsapp.net/v/t61.fake-dp.jpg');
});

// --- status -----------------------------------------------------------------
test('status reports registered/hasSession from KV, never credential values', async () => {
  const kv = makeFakeKv();
  const handler = createStatusHandler({ kv });
  let res = mockRes();
  await handler(mockReq({ method: 'GET', body: {} }), res);
  assert.deepEqual(res.jsonBody, { ok: true, registered: false, hasSession: false });

  seedRegisteredKv(kv);
  res = mockRes();
  await handler(mockReq({ method: 'GET', body: {} }), res);
  assert.deepEqual(res.jsonBody, { ok: true, registered: true, hasSession: true });
});
