// KV-backed Baileys auth state for serverless.
// No persistent disk on Vercel, so the session lives in Upstash KV as exactly
// two keys: dtz:dp-fetcher:creds (initAuthCreds object) and
// dtz:dp-fetcher:keys (signal key store), both BufferJSON-serialized.
// Load at the start of each function, persist on every creds.update /
// key-store mutation AND before returning, so a frozen instance never loses
// the session.

import { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { CREDS_KEY, KEYS_KEY } from './kv.js';

function parseStored(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw, BufferJSON.reviver); } catch { return null; }
}

/**
 * Load the auth state from KV. Returns { creds, keys, keysObj, persist }.
 * `keysObj` is the live in-memory key map — persist() writes it back to KV.
 */
export async function loadAuth(kv, logger) {
  const credsRaw = await kv.get(CREDS_KEY).catch(() => null);
  const keysRaw = await kv.get(KEYS_KEY).catch(() => null);
  const creds = parseStored(credsRaw) || initAuthCreds();
  const keysObj = parseStored(keysRaw) || {};

  // Minimal SignalKeyStore over the in-memory map; the cacheable wrapper
  // adds the 5-minute cache Baileys expects.
  const store = {
    get: (type, ids) => {
      const out = {};
      const bucket = keysObj[type] || {};
      for (const id of ids) if (bucket[id] !== undefined) out[id] = bucket[id];
      return out;
    },
    set: (data) => {
      for (const [type, entries] of Object.entries(data)) {
        keysObj[type] = keysObj[type] || {};
        Object.assign(keysObj[type], entries);
      }
    },
  };
  const keys = makeCacheableSignalKeyStore(store, logger);

  async function persist() {
    await kv.set(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
    await kv.set(KEYS_KEY, JSON.stringify(keysObj, BufferJSON.replacer));
  }

  return { creds, keys, keysObj, persist };
}
