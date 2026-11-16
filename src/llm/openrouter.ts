import { config, required } from "../config.js";
import { receptionistFunctions } from "./functions.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface TurnResult {
  reply: string | null;
  toolCalls: ToolCall[];
}

export async function runTurn(messages: ChatMessage[]): Promise<TurnResult> {
  const apiKey = required("OPENROUTER_API_KEY");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages,
      tools: receptionistFunctions,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
  };

  const message = data.choices[0]?.message;
  return {
    reply: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
  };
}

/**
 * Produces a short human-readable summary of a finished call — what the
 * caller wanted and what to do next — so whoever looks at the call
 * dashboard doesn't have to read the full transcript to know what happened
 * (asked for live, 2026-11-16, especially for calls that ended on a hangup
 * before take_message was ever called, where the raw transcript is all
 * that's recorded).
 */
export async function summarizeTranscript(transcript: string): Promise<string> {
  const apiKey = required("OPENROUTER_API_KEY");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages: [
        {
          role: "system",
          content:
            "You summarize a phone call for a Cerdik Tech agent who hasn't heard it. In 2-3 short sentences: what the caller wanted, any details they gave (name, company, size, product interest, contact info), and what the agent should do next. Plain text, no markdown, no preamble like \"Summary:\".",
        },
        { role: "user", content: transcript },
      ],
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter summary request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
  return data.choices[0]?.message?.content?.trim() || "(summary unavailable)";
}
