// agent.js — Gemini tool-use loop
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { toolDefinitions, executeTool } from './tools.js';
import { getHistory, appendHistory } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_SYSTEM_PROMPT = await fs.readFile(path.join(__dirname, 'system-prompt.md'), 'utf-8');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL               = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_TOOL_ROUNDS     = Number(process.env.MAX_TOOL_ROUNDS || 15);
const TOOL_RESULT_CHAR_CAP = 100_000;

function clip(str, n) {
  return str.length <= n ? str : `${str.slice(0, n)}\n...[truncated]`;
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

/**
 * Run one user turn through Gemini with tool-use.
 * Gemini contents shape: { role: 'user'|'model', parts: [ {text} | {functionCall} | {functionResponse} ] }
 */
export async function runAgent(sessionId, userMessage, userContext = null) {
  const history  = getHistory(sessionId);
  const userTurn = { role: 'user', parts: [{ text: userMessage }] };
  const contents = [...history, userTurn];
  const newTurns = [userTurn];
  const toolCallLog = [];

  const systemPrompt = buildSystemPrompt(userContext);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: toolDefinitions }],
        },
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[agent] Gemini API error:', msg);
      throw new Error(msg);
    }

    const parts     = response.candidates?.[0]?.content?.parts || [];
    const modelTurn = { role: 'model', parts };
    contents.push(modelTurn);
    newTurns.push(modelTurn);

    const calls = response.functionCalls || [];

    if (calls.length > 0) {
      const results = await Promise.all(
        calls.map(async (call) => {
          const start  = Date.now();
          const result = await executeTool(call.name, call.args || {});
          toolCallLog.push({
            round: round + 1,
            name: call.name,
            input: call.args || {},
            ok: !result?.error,
            durationMs: Date.now() - start,
          });

          // functionResponse.response must be an object; wrap primitives/arrays
          let wrapped;
          if (result === null || result === undefined) {
            wrapped = { result: null };
          } else if (typeof result !== 'object' || Array.isArray(result)) {
            wrapped = { result };
          } else {
            wrapped = result;
          }

          // Cap huge payloads so we don't blow the context window
          const serialized = JSON.stringify(wrapped);
          const payload = serialized.length > TOOL_RESULT_CHAR_CAP
            ? { truncated: true, content: clip(serialized, TOOL_RESULT_CHAR_CAP) }
            : wrapped;

          return {
            functionResponse: {
              name: call.name,
              response: payload,
            },
          };
        }),
      );

      const resultTurn = { role: 'user', parts: results };
      contents.push(resultTurn);
      newTurns.push(resultTurn);
      continue;
    }

    // No tool calls → done
    const textReply = (response.text || '').trim();
    appendHistory(sessionId, ...newTurns);
    return { text: textReply || '(no response)', toolCalls: toolCallLog };
  }

  appendHistory(sessionId, ...newTurns);
  return {
    text: "I hit my tool-use limit. Try breaking the request into smaller steps.",
    toolCalls: toolCallLog,
  };
}
