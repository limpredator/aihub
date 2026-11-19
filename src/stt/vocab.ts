import type { TenantConfig } from "../config/tenantConfig.js";

// Speechmatics' general model won't reliably catch domain jargon and product
// codes it's never heard before (e.g. "FXS", "CD20", "PoE") — biasing
// recognition toward them via additional_vocab is the cheapest accuracy
// lever available without retraining anything. Derived from the tenant's
// own config rather than hardcoded, so it stays correct as tenants/verticals
// change (see ROADMAP.md's multi-tenant section) instead of only ever
// fitting the current PBX-supplier client.

function looksLikeJargon(word: string): boolean {
  if (!/^[A-Z]/.test(word)) return false; // excludes lowercase noise like "9am-6pm"'s "am-6pm"
  if (/[0-9]/.test(word) && /[A-Za-z]/.test(word)) return true; // CD20, D2SW, A48WAC
  if (/^[A-Z][A-Z-]{1,}[A-Z]$/.test(word)) return true; // IP-PABX, FXS, FXO, SIP
  if (/^[A-Z][a-z]+[A-Z]/.test(word)) return true; // PoE
  return false;
}

export function extractVocabTerms(tenant: TenantConfig): string[] {
  const text = [tenant.companyName, tenant.companyDescription, tenant.products, tenant.simpleTerms, tenant.companyFacts].join(
    "\n",
  );
  const words = text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  const terms = new Set<string>();
  terms.add(tenant.companyName);
  for (const word of words) {
    const cleaned = word.replace(/^-+|-+$/g, "");
    if (cleaned.length >= 2 && looksLikeJargon(cleaned)) terms.add(cleaned);
  }
  // Speechmatics doesn't document a hard cap, but a shorter list keeps the
  // bias focused on genuinely distinctive terms rather than diluting it.
  return [...terms].slice(0, 50);
}
