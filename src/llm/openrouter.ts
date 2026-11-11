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
