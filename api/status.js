// GET /api/status — is a paired WhatsApp session stored in KV?
// Returns only booleans. Credential values are NEVER returned or logged.

import { BufferJSON } from '@whiskeysockets/baileys';
import { kvConfigFromEnv, createKvClient, CREDS_KEY } from '../lib/kv.js';
import { sendJson } from '../lib/util.js';

export function createStatusHandler(deps = {}) {
  return async (req, res) => {
    let registered = false;
    let hasSession = false;
    try {
      const kv = deps.kv || createKvClient(kvConfigFromEnv());
      const raw = await kv.get(CREDS_KEY);
      if (raw) {
        hasSession = true;
        try { registered = !!JSON.parse(raw, BufferJSON.reviver).registered; } catch { registered = false; }
      }
    } catch { /* unconfigured KV reads as "not paired" */ }
    sendJson(res, 200, { ok: true, registered, hasSession });
  };
}

export default createStatusHandler();
