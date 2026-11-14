// Upstash KV client over the REST API. Values are plain strings.
// Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN,
//      falling back to KV_REST_API_URL + KV_REST_API_TOKEN.
// NEVER log credential contents; only masked numbers are logged elsewhere.

export function kvConfigFromEnv(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  return { url, token };
}

export function createKvClient(config, fetchImpl = globalThis.fetch) {
  const { url, token } = config || {};
  if (!url || !token) {
    throw new Error('KV_NOT_CONFIGURED');
  }
  const base = String(url).replace(/\/$/, '');
  const authHeader = 'Bearer ' + token;
  async function get(key) {
    const res = await fetchImpl(base + '/get/' + encodeURIComponent(key), {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) throw new Error('KV_READ_FAILED');
    const data = await res.json();
    if (!data || data.result === undefined || data.result === null) return null;
    return data.result;
  }
  async function set(key, value) {
    const res = await fetchImpl(base + '/set/' + encodeURIComponent(key) + '/' + encodeURIComponent(value), {
      method: 'POST',
      headers: { Authorization: authHeader },
    });
    if (!res.ok) throw new Error('KV_WRITE_FAILED');
    return true;
  }
  return { get, set };
}

export const CREDS_KEY = 'dtz:dp-fetcher:creds';
export const KEYS_KEY = 'dtz:dp-fetcher:keys';
