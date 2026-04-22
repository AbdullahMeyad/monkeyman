// memory.js
// Session-keyed conversation history with a 4-hour idle TTL.
//
// KEY FIX: Never trim in the middle of a tool-use exchange.
// The Anthropic API requires that every tool_result in a user turn
// has a matching tool_use in the immediately preceding assistant turn.
// Naive slice-by-count can orphan tool_results, causing HTTP 400.
//
// Safe trim rule: only drop messages from the front at a point where
// the NEXT message is a plain user text turn (not a tool_result turn).
// That guarantees the remaining history always starts with a clean exchange.

const TTL_MS      = 1000 * 60 * 60 * 4;  // 4-hour idle TTL
const MAX_MESSAGES = 40;                   // max messages kept

const sessions = new Map();

/** True if this message is a "tool result" user turn (not a human text message) */
function isToolResultTurn(msg) {
  if (msg.role !== 'user') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.every(b => b.type === 'tool_result');
}

/**
 * Trim history to at most MAX_MESSAGES, but only cut at a safe boundary:
 * the message at position [cutPoint] must be a plain user turn, not a
 * tool_result turn, so the remaining slice starts a valid exchange.
 */
function safeTrim(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;

  // How many we want to drop from the front
  const excess = messages.length - MAX_MESSAGES;

  // Walk forward from `excess` to find the first index that is safe to start at.
  // Safe = the message at that index is a plain user turn (role=user, content=string
  // or content=[{type:'text',...}]), not a tool_result continuation.
  for (let i = excess; i < messages.length - 1; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && !isToolResultTurn(msg)) {
      return messages.slice(i);
    }
  }

  // Fallback: nothing safe found — keep everything (better to grow than corrupt)
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