# MonkeyMan Claude Agent

Drop-in replacement for the n8n MonkeyMan workflow. Runs **Claude Sonnet 4.6** with all 26 tools wired up natively, ships with a built-in browser test console at `/`, and exposes the same `/chat` contract your existing UI calls.

## Quick start (3 commands, then open a browser)

```bash
cp .env.example .env     # edit to add ANTHROPIC_API_KEY
npm install
npm start
```

Then open **http://localhost:3000** — that's the test console. Type, hit send, see responses with full markdown rendering and tool-call traces below each reply.

## What's in the box

| File | Purpose |
|---|---|
| `server.js` | Express HTTP server. Serves the test UI at `/`, the chat agent at `POST /chat`, plus the legacy `/mm-send-otp` and `/mm-verify-otp` endpoints kept for any other system that still calls them. |
| `agent.js` | Claude tool-use loop. Returns the text reply plus a per-turn tool-call trace. |
| `tools.js` | All 26 MonkeyMan tools as Anthropic tool defs + HTTP handlers. |
| `otp.js` | Direct port of your two n8n Code nodes — same hash, same 5-min window, so existing OTPs stay valid through the cutover. |
| `memory.js` | In-memory session store with 4-hour idle TTL (mirrors the n8n Simple Memory node). |
| `system-prompt.md` | Your full MonkeyMan system prompt. Edit this file to tune behaviour without touching code. |
| `public/index.html` | The browser test console (single self-contained file). |
| `.env.example` | Config template. |

## Setup details

```bash
cp .env.example .env
```

Open `.env`. For **local testing**, the minimum you need is:

```
ANTHROPIC_API_KEY=sk-ant-api03-...your-real-key...
MONKEYMAN_API_BASE=https://server.monkeymans.com/api
OTP_SECRET=mmK8#nQ3$wL9!pS6@rT4&xZ2^bV5
GHL_OTP_WEBHOOK=
PORT=3000
```

**Leave `GHL_OTP_WEBHOOK` empty** for testing — OTP codes will print to your server terminal as `[DEV-OTP] email -> 123456` instead of being emailed. The browser UI shows a yellow banner when this dev mode is active, so it's obvious.

Get an API key at https://console.anthropic.com → Settings → API Keys. Add a few dollars of credit on the Billing page (Sonnet 4.6 is roughly $3/M input + $15/M output tokens — testing will cost cents).

```bash
npm install
npm start
```

You should see:
```
🐵  MonkeyMan Claude agent listening on http://localhost:3000
   ⚙️   DEV MODE — OTP codes will print to this terminal instead of being emailed.
```

## Testing in the browser

Open **http://localhost:3000**. The console has six suggested prompts that exercise different code paths:

| Prompt | What it tests |
|---|---|
| Show me the equipment inventory | `equipment_products_tool` (read) |
| Who is on call this month? | `get_all_on_call_rotations` (read) |
| List all available forms and checklists | `list_forms` (read) |
| What permits do I need in Milwaukie? | `permit_rules_lookup` (read) |
| Help me request PTO | The PTO clarification flow (no tool yet) |
| What can you help me with? | No tool — pure prompt-following |

**The OTP write flow** (the security-critical bit). Type something like:

> Approve the pending PTO for jordyn@monkeymans.com. I'm newguy@monkeymans.com. Comment: looks good.

You should see the role-gate tool fire, then `Send_OTP`, then the assistant asks for the code. **Look in your server terminal** — you'll see `[DEV-OTP] newguy@monkeymans.com -> 123456`. Paste that 6-digit code as your next message; the agent will call `Verify_OTP` then `Approve_or_Deny_a_PTO`.

**Test the role gate refusal** (this is the security test that mattered most in your prompt). Use a real Employee-level email instead of a manager:

> Approve Jordyn's PTO. I'm someEmployee@monkeymans.com.

Watch your server terminal: there should be **no** `[DEV-OTP]` printed. The role gate must reject before `Send_OTP` is called. The assistant's reply should be the polite refusal template. If you see an OTP get sent here, the role gate isn't working — file a bug.

**Tool call traces**: under every assistant message, small badges show which tools fired and how long they took. Hover one to see the exact input Claude passed. Use this to verify the agent is making the right calls in the right order.

**New session** button: clears server-side memory for the current session and gives you a fresh ID, so you can re-test scenarios without polluted context.

## Endpoints (for your existing chat UI)

```
GET  /                  → test console (HTML)
POST /chat              { sessionId, chatInput } → { output, toolCalls }
DELETE /chat/:sessionId → { ok: true }
POST /mm-send-otp       { email, firstName?, lastName?, phone? }   (legacy)
POST /mm-verify-otp     { email, otp }                              (legacy)
GET  /health            → { ok, model, devMode }
```

`/chat` is a superset of the n8n webhook response — your existing UI reading `data.output` will continue to work; the new `data.toolCalls` field is optional.

## Cutover from n8n

1. Stand this service up at e.g. `https://agent.monkeymans.com`.
2. Smoke-test with the browser console at the new URL.
3. Flip your real chat UI's webhook URL from the n8n one to `https://agent.monkeymans.com/chat`.
4. Decommission the n8n workflow once you're satisfied.

## Common things that break

- **`Cannot find package '@anthropic-ai/sdk'`** — you skipped `npm install`.
- **`401 invalid x-api-key`** — typo in `ANTHROPIC_API_KEY` or no billing credit.
- **All tool calls return `Network error`** — your machine can't reach `server.monkeymans.com`. Test with `curl https://server.monkeymans.com/api/employee/all` directly. If that fails, it's a firewall/DNS issue, not the agent.
- **Claude calls tools but ignores the role gate** — the system prompt didn't load. Check that `system-prompt.md` is next to `agent.js` and hasn't been truncated.
- **Browser shows blank page** — check that `public/index.html` exists and that you ran `npm start` from the project root.

## Deploy options

The whole thing is a stateless-ish Node.js HTTP server. Anywhere that runs Node 20+ works:

- **Railway / Render / Fly.io** — push the repo, set env vars in their dashboard, done. Best dev-to-prod ratio. Make sure to fill in `GHL_OTP_WEBHOOK` so OTPs actually email out in production.
- **A VPS with PM2** — `pm2 start server.js --name monkeyman-agent`. Cheapest.
- **Docker** — five-line `Dockerfile`: `FROM node:20-alpine`, copy, install, expose 3000, `CMD ["node", "server.js"]`.

## Production checklist

- [ ] **Session memory**: the in-memory `Map` in `memory.js` is fine for one process. For multi-instance deploys, swap it for Redis. The interface is just `getHistory` / `appendHistory` / `clearSession` — easy swap.
- [ ] **Rotate `OTP_SECRET`** away from the n8n default and into a real secret manager.
- [ ] **Lock CORS down** to your chat UI's origin (currently `*`).
- [ ] **Authenticate `/chat`**: the original n8n webhook was open. Add a header check or short-lived bearer token before going public.
- [ ] **Disable the test UI in production** — either don't deploy `public/`, or add an auth wall in front of `GET /`.
- [ ] **Add request logging / Sentry** for visibility into agent errors and tool failures.
- [ ] **Monitor token spend** via the Anthropic console.

## Tweak knobs

- `MAX_TOOL_ROUNDS` (env) — caps tool-use loops per user message. Default 15.
- `MODEL` constant in `agent.js` — switch to Opus 4.7 for the very hardest cases or Haiku 4.5 for cheaper/faster.
- `TTL_MS` and `MAX_MESSAGES` in `memory.js` — tune session retention.
- Welcome examples in `public/index.html` — edit the `<button class="example">` list.
