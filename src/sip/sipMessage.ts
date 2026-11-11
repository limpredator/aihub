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

export interface ParsedRequest {
  method: string;
  uri: string;
  headers: Record<string, string>;
  body: string;
}

/** Parses a SIP request's start line, headers, and body (e.g. an incoming INVITE/ACK/BYE). */
export function parseRequest(raw: string): ParsedRequest {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerPart = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? "" : raw.slice(headerEnd + 4);

  const [startLine, ...headerLines] = headerPart.split("\r\n");
  const match = startLine.match(/^([A-Z]+) (\S+) SIP\/2\.0$/);
  if (!match) throw new Error(`Not a SIP request line: ${startLine}`);

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { method: match[1], uri: match[2], headers, body };
}

/** Builds a SIP response, echoing the request's dialog headers, with an optional body. */
export function buildResponse(opts: {
  status: number;
  reason: string;
  request: ParsedRequest;
  localTag?: string;
  contact?: string;
  body?: string;
  contentType?: string;
}): string {
  const { status, reason, request, body = "", contentType = "application/sdp" } = opts;

  let toHeader = request.headers["to"] ?? "";
  if (opts.localTag && !toHeader.includes("tag=")) {
    toHeader = `${toHeader};tag=${opts.localTag}`;
  }

  const lines = [
    `SIP/2.0 ${status} ${reason}`,
    `Via: ${request.headers["via"]}`,
    `From: ${request.headers["from"]}`,
    `To: ${toHeader}`,
    `Call-ID: ${request.headers["call-id"]}`,
    `CSeq: ${request.headers["cseq"]}`,
  ];
  if (opts.contact) lines.push(`Contact: <${opts.contact}>`);
  if (body) lines.push(`Content-Type: ${contentType}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`, "", body);
  return lines.join("\r\n");
}

/**
 * Buffers a TLS/TCP byte stream into complete SIP messages, using the
 * \r\n\r\n header terminator plus Content-Length to find each message's
 * end — unlike assuming one "data" event is one message (not safe once a
 * body, e.g. INVITE's SDP, can split across TCP segments or several
 * messages can arrive coalesced in one segment).
 */
export class SipStreamFramer {
  private buffer = "";

  /** Feeds newly-received bytes; returns zero or more complete raw SIP messages. */
  push(chunk: Buffer | string): string[] {
    this.buffer += chunk.toString();
    const messages: string[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerPart = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = headerPart.match(/^content-length:\s*(\d+)\s*$/im);
      const contentLength = contentLengthMatch ? Number(contentLengthMatch[1]) : 0;

      const messageEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < messageEnd) break;

      messages.push(this.buffer.slice(0, messageEnd));
      this.buffer = this.buffer.slice(messageEnd);
    }

    return messages;
  }
}
