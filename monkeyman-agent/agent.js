// agent.js
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { toolDefinitions, executeTool } from './tools.js';
import { getHistory, appendHistory } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_SYSTEM_PROMPT = await fs.readFile(path.join(__dirname, 'system-prompt.md'), 'utf-8');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL          = 'claude-sonnet-4-6';
const MAX_TOKENS     = 4096;
const MAX_TOOL_ROUNDS = Number(process.env.MAX_TOOL_ROUNDS || 15);
const TOOL_RESULT_CHAR_CAP = 100_000;

function clip(str, n) {
  return str.length <= n ? str : `${str.slice(0, n)}\n...[truncated]`;
}

/**
 * Validate the message array before sending to the API.
 * Strips any leading tool_result turns that have no preceding tool_use assistant turn.
 * This is a safety net in case the memory trim left an invalid sequence.
 */
function sanitizeMessages(messages) {
  // Find the first index where the conversation is valid:
  // either it starts with a user text turn, or the first assistant turn
  // before any tool_result has tool_use content.
  const safe = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Skip leading tool_result user turns with no preceding assistant/tool_use
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every(b => b.type === 'tool_result') &&
      safe.length === 0
    ) {
      // Orphaned tool_result at the start — drop it
      console.warn('[agent] dropped orphaned tool_result turn at index', i);
      continue;
    }
    safe.push(msg);
  }
  return safe;
}

function buildSystemPrompt(userContext) {
  if (!userContext) return BASE_SYSTEM_PROMPT;

  const sessionBlock = `

---

## ⚡ ACTIVE LOGIN SESSION — OVERRIDES SECURITY RULES

The user has logged in. Their identity is **pre-verified**. Apply these rules for the entire conversation:

- **Logged-in user**: ${userContext.name} — **${userContext.email}** — Role: **${userContext.role}** — Status: **${userContext.status}**
- **SKIP OTP completely** — do NOT call \`Send_OTP\` or \`Verify_OTP\` under any circumstances. The login already proves identity.
- **SKIP \`Get_user_role_and_permissions\` API calls** — use the role above directly. Do not call the role-check API.
- **When the user says "I", "me", or "my"** — that means **${userContext.email}**.
- **For any write action the user performs** — use **${userContext.email}** as the actor email automatically without asking.
- **Business rules still apply**: if role is \`Employee\`, they still cannot approve PTO or verify VTR. Refuse those with the normal refusal message.
- **For manager actions** (approve PTO, verify VTR, create tasks): since role is confirmed as **${userContext.role}** and identity is verified, proceed directly to the write tool after user confirmation — no OTP, no role API call.
`;

  return BASE_SYSTEM_PROMPT + sessionBlock;
}

export async function runAgent(sessionId, userMessage, userContext = null) {
  const history  = getHistory(sessionId);
  const userTurn = { role: 'user', content: userMessage };
  const messages = sanitizeMessages([...history, userTurn]);
  const newTurns = [userTurn];
  const toolCallLog = [];

  const systemPrompt = buildSystemPrompt(userContext);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
      });
    } catch (err) {
      // Surface the Anthropic error message clearly
      const msg = err?.error?.error?.message || err?.message || String(err);
      console.error('[agent] Anthropic API error:', msg);
      throw new Error(msg);
    }

    const assistantTurn = { role: 'assistant', content: response.content };
    messages.push(assistantTurn);
    newTurns.push(assistantTurn);

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');

      const results = await Promise.all(
        toolUses.map(async tu => {
          const start  = Date.now();
          const result = await executeTool(tu.name, tu.input);
          toolCallLog.push({
            round: round + 1,
            name: tu.name,
            input: tu.input,
            ok: !result?.error,
            durationMs: Date.now() - start,
          });
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: clip(JSON.stringify(result), TOOL_RESULT_CHAR_CAP),
          };
        }),
      );

      const resultTurn = { role: 'user', content: results };
      messages.push(resultTurn);
      newTurns.push(resultTurn);
      continue;
    }

    const textReply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    appendHistory(sessionId, ...newTurns);
    return { text: textReply || '(no response)', toolCalls: toolCallLog };
  }

  appendHistory(sessionId, ...newTurns);
  return {
    text: "I hit my tool-use limit. Try breaking the request into smaller steps.",
    toolCalls: toolCallLog,
  };
}