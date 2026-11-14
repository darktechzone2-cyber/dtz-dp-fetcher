# DTZ WhatsApp DP Fetcher — Vercel serverless version v1.0

Download any WhatsApp profile photo in **full quality** by number — using your own WhatsApp account. Runs free on Vercel with a public link and no server to maintain.

## How it works

WhatsApp does not let a website fetch a stranger's DP by number alone. This tool logs in **your own WhatsApp once** (pairing code), saves the session in Upstash KV, and reconnects to WhatsApp on every fetch — because a serverless function has no live socket.

- Pair once → session saved in KV (`dtz:dp-fetcher:creds` + `dtz:dp-fetcher:keys`) → fetch any number.
- The photo comes back only when WhatsApp itself shows it to **your** account. A hidden DP (privacy: nobody, or contacts-only and you are not a contact) is never bypassed — you get an honest "not visible" message instead.
- No signup, no key, nothing uploaded anywhere.

## Routes

| Route | What it does |
|---|---|
| `GET /` | the web UI |
| `GET /api/status` | `{ ok, registered, hasSession }` — booleans only, never credential values |
| `POST /api/pair` | `{ number }` → streams the 8-digit pairing code as the first JSON line, then a `{"paired": true/false}` line |
| `POST /api/fetch` | `{ number }` → `{ ok, number, url }` (full-quality photo URL) |

## Deploy (Vercel)

1. Create a **free Upstash Redis** database (Upstash console or Vercel Marketplace → Upstash Redis) and copy its **REST URL** and **REST token**.
2. Import this repo into Vercel (or `vercel` from the folder).
3. In the Vercel project → Settings → Environment Variables, add:
   - `UPSTASH_REDIS_REST_URL` = the REST URL
   - `UPSTASH_REDIS_REST_TOKEN` = the REST token

   (Alternatively `KV_REST_API_URL` / `KV_REST_API_TOKEN` — same values.)
4. Deploy. Open the site, pair your WhatsApp once, then fetch.

## Usage

1. **Step 1** — enter YOUR WhatsApp number (with country code, e.g. `923001234567`) → Get pairing code → in WhatsApp: Linked devices → Link a device → enter the code. Be ready in WhatsApp **before** you request the code.
2. **Step 2** — enter the target number → Fetch DP → the full-size photo opens in a new tab (long-press / right-click to save).

## Honest limits (read this)

- **Pairing window is ~45 seconds.** The pairing code only works while the serverless function is alive (Vercel kills it at 60s). Enter the code in WhatsApp immediately. If it expires, request a new one.
- **Each fetch takes 15–30 seconds.** There is no always-on connection; every fetch reconnects to WhatsApp first.
- **Hidden DPs stay hidden.** If a number's privacy hides its photo from you, the tool says so — it cannot and does not bypass WhatsApp privacy.
- **One account at a time.** The KV session holds a single WhatsApp login.
- **If WhatsApp logs the session out**, pair again (Step 1).
- **Rate limits:** 20 fetches/minute per IP, 6 pairing attempts per 10 minutes.

## How the session survives serverless

Baileys normally keeps auth on disk (`useMultiFileAuthState`). There is no disk here, so the auth state is serialized with Baileys' `BufferJSON` into two Upstash keys (`dtz:dp-fetcher:creds` for the credentials, `dtz:dp-fetcher:keys` for the signal key store). Every function loads them at the start, and writes them back on every `creds.update` / key-store mutation **and** before returning — so even a frozen instance leaves a usable session.

## Files

```text
api/pair.js     # pairing (streams the code, waits ~42s for the owner)
api/fetch.js    # reconnect + profilePictureUrl('image')
api/status.js   # paired? (booleans only)
lib/kv.js       # Upstash REST client
lib/auth.js     # KV-backed Baileys auth state
lib/whatsapp.js # socket open/wait/retry helpers
lib/util.js     # number + URL + rate-limit helpers
public/index.html
tests/          # run: npm test (no real WhatsApp / no real Upstash — all faked)
```

## Tests

```bash
npm install
npm test
```

## Common problems

- **"Server storage is not configured"** — the Upstash env vars are missing in Vercel. Add them and redeploy.
- **"WhatsApp is not paired yet"** — do Step 1 first.
- **"No profile photo visible"** — the number has no photo, or its privacy hides it from you.
- **Pairing timed out** — you took longer than ~45 seconds. Have WhatsApp open on Linked devices before requesting the code.

Dark Tech Zone — Learn. Build. Secure.
