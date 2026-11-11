import { randomBytes, createHash } from "node:crypto";

// Minimal SIP message building/parsing — just enough for REGISTER +
// digest auth (RFC 3261 / RFC 2617). Not a general SIP stack: no SDP, no
// dialog state beyond what REGISTER needs.

export function generateCallId(): string {
  return randomBytes(16).toString("hex");
}

export function generateTag(): string {
  return randomBytes(8).toString("hex");
}

export function generateBranch(): string {
  return `z9hG4bK${randomBytes(8).toString("hex")}`;
}

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Parses the WWW-Authenticate header value from a 401 response. */
export function parseDigestChallenge(headerValue: string): DigestChallenge {
  const get = (key: string) => headerValue.match(new RegExp(`${key}="?([^",]+)"?`))?.[1];
  const realm = get("realm");
  const nonce = get("nonce");
  if (!realm || !nonce) throw new Error(`Malformed WWW-Authenticate header: ${headerValue}`);
  return { realm, nonce, qop: get("qop"), opaque: get("opaque"), algorithm: get("algorithm") };
}

/** Builds the Authorization header value for a digest-auth REGISTER retry. */
export function buildAuthorizationHeader(opts: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  cnonce: string;
  nc?: string;
}): string {
  const { username, password, method, uri, challenge, cnonce, nc = "00000001" } = opts;
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = challenge.qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=MD5`,
  ];
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

export interface RegisterParams {
  host: string;
  port: number;
  localAddress: string;
  localPort: number;
  extension: string;
  callId: string;
  fromTag: string;
  branch: string;
  cseq: number;
  expires?: number;
  authorization?: string;
}

export function buildRegister(p: RegisterParams): string {
  const aor = `sip:${p.extension}@${p.host}`;
  const contact = `sip:${p.extension}@${p.localAddress}:${p.localPort}`;
  const lines = [
    `REGISTER ${aor} SIP/2.0`,
    `Via: SIP/2.0/TLS ${p.localAddress}:${p.localPort};branch=${p.branch}`,
    `Max-Forwards: 70`,
    `To: <${aor}>`,
    `From: <${aor}>;tag=${p.fromTag}`,
    `Call-ID: ${p.callId}`,
    `CSeq: ${p.cseq} REGISTER`,
    `Contact: <${contact}>`,
    `Expires: ${p.expires ?? 300}`,
  ];
  if (p.authorization) lines.push(`Authorization: ${p.authorization}`);
  lines.push(`Content-Length: 0`, "", "");
  return lines.join("\r\n");
}

export interface ParsedResponse {
  status: number;
  reason: string;
  headers: Record<string, string>;
}

/** Parses a SIP response's status line and headers (no body handling). */
export function parseResponse(raw: string): ParsedResponse {
  const [statusLine, ...headerLines] = raw.split("\r\n");
  const match = statusLine.match(/^SIP\/2\.0 (\d+) (.+)$/);
  if (!match) throw new Error(`Not a SIP status line: ${statusLine}`);

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    if (!line.trim()) break;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status: Number(match[1]), reason: match[2], headers };
}
