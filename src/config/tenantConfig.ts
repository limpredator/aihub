// Company-specific content for the receptionist's system prompt, editable
// from the dashboard's Company Profile tab (src/dashboard/server.ts's
// /api/tenant-config routes) instead of being hardcoded in prompt.ts.
// Single-tenant for now — one file, no tenant id — multi-tenant (a config
// per client business) is a separate future project.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface TenantConfig {
  companyName: string;
  /** Short descriptor after the company name, e.g. "a Petaling Jaya-based business phone / IP-PABX supplier". */
  companyDescription: string;
  /** e.g. "English, Bahasa Malaysia, or Mandarin". */
  languages: string;
  /** Bullet list, one fact per line, starting each line with "- ". */
  companyFacts: string;
  /** Product/service catalog, free-form with its own sub-headers and bullets. */
  products: string;
  /** One sentence/paragraph describing how the products relate to each other. */
  howItFitsTogether: string;
  /** Bullet list of jargon definitions. */
  simpleTerms: string;
  /** Bullet list of frequently asked questions and their answers. */
  quickAnswers: string;
  /** Bullet list of things the AI must never say and must hand off instead. */
  neverDoThis: string;
}

export const DEFAULT_TENANT_CONFIG: TenantConfig = {
  companyName: "Cerdik Tech Sdn. Bhd.",
  companyDescription: "a Petaling Jaya-based business phone / IP-PABX supplier",
  languages: "English, Bahasa Malaysia, or Mandarin",
  companyFacts: `- Cerdik Tech Sdn. Bhd., Kelana Jaya, Petaling Jaya, Selangor. Sells business phone systems, phones, headsets and meeting-room screens.
- Authorised Malaysian distributor for Atcom IP phones. Authorised Mitel partner.
- Installs, configures and maintains systems, including legacy Panasonic, Alcatel, Ericsson-LG, Toshiba and Mitel PBXs.
- Based in and primarily serving the Klang Valley; other areas are served through installation partners (confirm case by case).
- Hours: Monday-Friday, 9am-6pm. Outside these hours, take a message rather than promising a callback time.
- Tone: plain and honest, no sales pressure. It's fine to say "I don't know" and offer to pass them to someone who does.`,
  products: `Phone systems (IP-PABX):
- CD20 — small offices. Up to 200 extensions, 50 concurrent calls. Built-in 4 analog phone ports + 4 phone-line ports.
- CD100 — growing businesses. Up to 800 extensions, 100 concurrent calls. Built-in 8 + 8 analog ports.
- CD300 — multi-branch, large sites. Up to 3,000 extensions, 300 concurrent calls. Branches share one number and extension range.
- Mitel SMBC — mid-size offices and hotels. Up to 150 users, or 350 hotel rooms.
- Mitel Ex — enterprise and large hotel groups. Up to 1,400 users, with backup power options.
Gateways (connect existing equipment):
- AG FXS gateway (16-96 ports) — keeps existing analog phones working on an IP system.
- AG FXO gateway (8 or 16 ports) — connects existing landlines (e.g. Telekom) to an IP system.
Atcom IP phones:
- D26 — standard wired desk phone, mono screen. D38 — same but colour screen.
- D2SW / D3SW — Wi-Fi desk phones for desks with no network cable (D3SW has the colour screen).
- A48WAC / A68WAC — executive phones, colour screen, dual-band Wi-Fi. A68WAC is the top model.
- A48 + AET — reception/operator set: phone plus a button console showing who's free/busy, for transferring calls.
Headsets (Cerdik):
- CD98 — plugs into desk phones (QD). CD96 — USB, for computers/softphones. CD990 — Bluetooth, for people who move around. Each comes in mono or two-ear (binaural).
Meeting rooms:
- IWB interactive whiteboards — touchscreens in 65, 75, 96 and 110 inch. Work with Teams, Zoom and Google Meet.`,
  howItFitsTogether: "phone system in the middle (routes calls, extensions, voicemail) → desk phones and headsets on desks → gateways for keeping old analog phones/landlines → SIP trunk or landline for outside calls.",
  simpleTerms: `- IP-PABX = the office phone system connecting extensions to each other and to outside lines.
- FXS = ports for phones. FXO = ports for incoming phone lines.
- SIP trunk = internet phone line from a provider, instead of a physical landline.
- PoE = the phone gets power through its network cable, no separate power adapter needed.`,
  quickAnswers: `- Keep old analog phones? Yes, with an AG FXS gateway (CD20/CD100 also have built-in FXS ports).
- Keep an existing landline or phone number? Yes, through an FXO gateway or number porting — a person will confirm details.
- Phone for reception? Atcom D38, or the A48 + AET set for busy switchboards.
- No network cable at a desk? Atcom D2SW, D3SW, A48WAC or A68WAC (all Wi-Fi).
- Which phone system fits? Under ~200 users: CD20. Up to 800: CD100. Multi-branch or bigger: CD300. Hotels: Mitel.
- Old PBX broken? We repair legacy systems. Emergency faults in the Klang Valley get same-day response; elsewhere usually 24-48 hours.`,
  neverDoThis: `- Never state a price, discount, quote, stock level or delivery timeline.
- Never promise integrations, API access, or compatibility between brands (e.g. CRM, hotel PMS, mixing Atcom/Mitel with other vendors).
- Never read out a phone number — the two numbers on file aren't confirmed yet. Offer to take the caller's number so the team can call back, or point them to email.
- Never quote sizing/design details (exact extension counts, site surveys, migrations, number porting) as settled — point in the right direction (see QUICK ANSWERS) but hand off for anything requiring a real design.`,
};

const CONFIG_PATH = join(process.cwd(), "data", "tenant-config.json");

export async function loadTenantConfig(): Promise<TenantConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_TENANT_CONFIG, ...raw };
  } catch {
    return DEFAULT_TENANT_CONFIG;
  }
}

export async function saveTenantConfig(patch: Partial<TenantConfig>): Promise<TenantConfig> {
  const current = await loadTenantConfig();
  const next = { ...current, ...patch };
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}
