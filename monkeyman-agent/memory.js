// memory.js
// Session-keyed Gemini conversation history with a 4-hour idle TTL.
//
// Gemini turn shape: { role: 'user'|'model', parts: [ {text} | {functionCall} | {functionResponse} ] }
//
// KEY RULE: Never trim in the middle of a tool-use exchange. A user turn whose
// parts are all `functionResponse` must be preceded by a `model` turn that
// issued the matching `functionCall`s. Orphaned tool-response turns produce
// API errors. Safe-trim only at a boundary where the next message is a plain
// user text turn.

const TTL_MS       = 1000 * 60 * 60 * 4;  // 4-hour idle TTL
const MAX_MESSAGES = 40;                   // max messages kept

const sessions = new Map();

/** True if this message is a tool-response continuation (not a human text turn). */
function isToolResponseTurn(msg) {
  if (msg.role !== 'user') return false;
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) return false;
  return msg.parts.every(p => p && p.functionResponse !== undefined);
}

/**
 * Trim history to at most MAX_MESSAGES, but only cut at a safe boundary:
 * the message at [cutPoint] must be a plain user text turn, not a tool
 * response continuation, so the remaining slice starts a valid exchange.
 */
function safeTrim(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;

  const excess = messages.length - MAX_MESSAGES;

  for (let i = excess; i < messages.length - 1; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && !isToolResponseTurn(msg)) {
      return messages.slice(i);
    }
  }

  // Nothing safe found — better to grow than corrupt the sequence
  return messages;
}

export function getHistory(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return [];
  if (Date.now() - entry.lastTouched > TTL_MS) {
    sessions.delete(sessionId);
    return [];
  }
  return entry.messages;
}

export function appendHistory(sessionId, ...messages) {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { messages: [], lastTouched: Date.now() };
    sessions.set(sessionId, entry);
  }
  entry.messages.push(...messages);
  entry.messages    = safeTrim(entry.messages);
  entry.lastTouched = Date.now();
}

export function clearSession(sessionId) {
  sessions.delete(sessionId);
}

// Periodic GC — remove idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastTouched > TTL_MS) sessions.delete(id);
  }
}, 1000 * 60 * 30).unref();
