// Turns a company website / PDF / PowerPoint into a *draft* TenantConfig for
// the dashboard's Company Profile tab — never saved directly. The person
// always reviews and edits the draft before hitting Save, because raw
// scraped/extracted text has no idea about the "never quote a price" type
// rules that belong in TenantConfig, and an LLM asked to "use this text as
// context" will happily repeat whatever it finds (a price on a pricing page,
// a stale phone number, marketing fluff) unless a person checks it first.
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import { config, required } from "../config.js";
import type { TenantConfig } from "./tenantConfig.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Keeps the extracted text (and therefore the draft request's cost/latency)
// bounded regardless of how large the source document or page is.
const MAX_SOURCE_CHARS = 20000;

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const numOf = (p: string) => Number(p.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      return numOf(a) - numOf(b);
    });

  const slideTexts = await Promise.all(
    slidePaths.map(async (path) => {
      const xml = await zip.files[path].async("text");
      // Slide text lives in <a:t>...</a:t> runs; this is a format-specific
      // shortcut instead of a full XML parse, since that's all we need here.
      const matches = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      return matches.join(" ");
    }),
  );

  return slideTexts.map((text, i) => `Slide ${i + 1}: ${text}`).join("\n");
}

export async function extractTextFromUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported");
  }

  const res = await fetch(parsed, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CerdikProfileImport/1.0)" } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const DRAFT_FIELDS: (keyof TenantConfig)[] = [
  "companyName",
  "companyDescription",
  "languages",
  "companyFacts",
  "products",
  "howItFitsTogether",
  "simpleTerms",
  "quickAnswers",
  "neverDoThis",
];

export async function draftTenantConfigFromText(rawText: string): Promise<Partial<TenantConfig>> {
  const apiKey = required("OPENROUTER_API_KEY");
  const trimmed = rawText.trim().slice(0, MAX_SOURCE_CHARS);
  if (!trimmed) throw new Error("No text could be extracted from that source");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You draft a phone receptionist's knowledge base from raw company material (a website, brochure or slide deck). Output ONLY a JSON object with these string fields: ${DRAFT_FIELDS.join(", ")}.
- companyFacts, simpleTerms, quickAnswers, neverDoThis: bullet lists, one fact per line, each line starting with "- ".
- products: free-form catalog text, your own headers/bullets, naming only products/services actually mentioned in the source.
- companyDescription: a short phrase following "You are the phone receptionist for {companyName}, ___" (e.g. "a Petaling Jaya-based business phone supplier").
- howItFitsTogether: one sentence.
- neverDoThis: always include "Never state a price, discount, quote, stock level or delivery timeline" plus anything else from the source that looks unconfirmed (phone numbers, exact specs) — a human reviews this draft before it goes live, but default to caution.
- Leave a field as an empty string if the source doesn't cover it — never invent specifics (prices, phone numbers, addresses) that aren't in the source text.`,
        },
        { role: "user", content: trimmed },
      ],
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter draft request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Model returned no content");

  // response_format: json_object isn't consistently honored by every
  // OpenRouter-routed model — some still wrap the object in a ```json fence
  // or add a sentence before/after it — so pull out the first {...} block
  // rather than assuming the whole response is bare JSON.
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Model did not return a JSON object");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  const draft: Partial<TenantConfig> = {};
  for (const field of DRAFT_FIELDS) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) draft[field] = value;
  }
  return draft;
}
