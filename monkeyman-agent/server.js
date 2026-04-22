// server.js
import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent } from './agent.js';
import { sendOtp, verifyOtp } from './otp.js';
import { clearSession } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.MONKEYMAN_API_BASE || 'https://server.monkeymans.com/api';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';   // if blank → any password accepted
const DEV_MODE = !process.env.GHL_OTP_WEBHOOK;
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;  // 8 hours

// ─── Auth session store ───────────────────────────────────────────────────────
// Map<token, { email, role, name, status, createdAt }>
const authSessions = new Map();

function getAuthSession(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const session = authSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    authSessions.delete(token);
    return null;
  }
  return session;
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of authSessions) {
    if (now - s.createdAt > SESSION_TTL_MS) authSessions.delete(t);
  }
}, 1000 * 60 * 30).unref();

// ─── HTTP helper for MonkeyMan API ───────────────────────────────────────────
async function mmFetch(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ─── Express setup ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files — login.html and index.html live in public/
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth routes ─────────────────────────────────────────────────────────────

// POST /auth/login  { email, password }
app.post('/auth/login', async (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const password = req.body?.password || '';

  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Password check (if LOGIN_PASSWORD is set in .env)
  if (LOGIN_PASSWORD && password !== LOGIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  try {
    // 1. Verify employee exists
    const enc = encodeURIComponent;
    const employee = await mmFetch(`/employee/email/${enc(email)}`);
    if (!employee) {
      return res.status(401).json({ error: 'No employee found with that email' });
    }

    // 2. Get their role
    const roleData = await mmFetch(`/employee/email/${enc(email)}/role`);
    if (!roleData) {
      return res.status(401).json({ error: 'Could not retrieve role for this employee' });
    }

    if (roleData.status !== 'Active') {
      return res.status(401).json({ error: `Account is ${roleData.status || 'inactive'}. Contact your admin.` });
    }

    // 3. Build session
    const name = [employee.firstName, employee.lastName].filter(Boolean).join(' ') || email;
    const token = randomUUID();

    authSessions.set(token, {
      token,
      email,
      role: roleData.role || 'Employee',
      name,
      status: roleData.status,
      permissions: roleData.permissions || [],
      createdAt: Date.now(),
    });

    console.log(`[login] ✅ ${name} (${email}) — ${roleData.role}`);

    res.json({ token, email, role: roleData.role, name });
  } catch (err) {
    console.error('[login] error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) authSessions.delete(token);
  res.json({ ok: true });
});

// GET /auth/me  — returns current session info (used on page load to restore state)
app.get('/auth/me', (req, res) => {
  const session = getAuthSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ email: session.email, role: session.role, name: session.name });
});

// ─── Chat ────────────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  // Require login
  const session = getAuthSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  const { sessionId, chatInput } = req.body;
  if (!sessionId || !chatInput) {
    return res.status(400).json({ error: 'sessionId and chatInput are required' });
  }

  try {
    // Pass the logged-in user context so Claude skips OTP
    const { text, toolCalls } = await runAgent(sessionId, chatInput, session);
    res.json({ output: text, toolCalls });
  } catch (err) {
    console.error('[/chat] agent error:', err);
    res.status(500).json({ error: err.message || 'Agent failed' });
  }
});

app.delete('/chat/:sessionId', (req, res) => {
  clearSession(req.params.sessionId);
  res.json({ ok: true });
});

// ─── Legacy OTP webhooks (kept for any other system that calls them) ─────────
app.post('/mm-send-otp', async (req, res) => {
  const result = await sendOtp(req.body || {});
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/mm-verify-otp', (req, res) => {
  const result = verifyOtp(req.body || {});
  res.status(result.verified ? 200 : 401).json(result);
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  ok: true,
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  devMode: DEV_MODE,
}));

// On Vercel, export the app as a serverless handler — do NOT call app.listen.
// Locally (no VERCEL env var), bind a port like before.
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`\n🐵  MonkeyMan Claude agent listening on http://localhost:${PORT}\n`);
    if (DEV_MODE) {
      console.log('   ⚙️   DEV MODE — OTPs print to this terminal if triggered.');
    }
    if (!process.env.GEMINI_API_KEY) {
      console.warn('   ⚠️   GEMINI_API_KEY not set — chat will fail until you set it.');
    }
    if (!LOGIN_PASSWORD) {
      console.log('   ℹ️   LOGIN_PASSWORD not set — any password will be accepted at login.');
    }
    console.log('');
  });
}

export default app;
