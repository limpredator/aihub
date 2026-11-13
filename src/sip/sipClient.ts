import { connect, type TLSSocket } from "node:tls";
import { EventEmitter } from "node:events";
import { config } from "../config.js";
import {
  buildRegister,
  parseResponse,
  parseRequest,
  buildResponse,
  buildDialogRequest,
  parseDigestChallenge,
  buildAuthorizationHeader,
  generateCallId,
  generateTag,
  generateBranch,
  extractUri,
  extractCallerId,
  SipStreamFramer,
  type ParsedRequest,
} from "./sipMessage.js";

// Registers over plain SIP/TLS (port 5061) — the same transport the native
// Linphone clients (iPhone/tablet) already use against this proxy in
// production. Deliberately not WSS: that path implies WebRTC media
// (ICE/DTLS-SRTP), which would need a native Node WebRTC stack for no
// benefit here.
//
// UNVERIFIED end-to-end: written correctly against RFC 3261/2617, but not
// yet tested against the real proxy — needs a provisioned SIP_EXTENSION/
// SIP_PASSWORD and ring group membership on the PBX side first.
//
// After registering, the socket is kept open and fed through
// SipStreamFramer so an inbound INVITE's SDP body can't be lost to the
// "one data event = one message" assumption the registration handshake
// got away with (REGISTER/its responses carry no body).

export type SipRegistrationState = "unregistered" | "registering" | "registered" | "failed";

export interface IncomingCall {
  callId: string;
  remoteSdp: string;
  /** The caller's number/user part, extracted from the From header. */
  callerId: string;
  /** Answers the call: sends 200 OK with the given local SDP. */
  answer(localSdp: string): void;
  /** Rejects the call with a non-2xx final response (default 486 Busy Here). */
  reject(status?: number, reason?: string): void;
}

interface Dialog {
  request: ParsedRequest;
  localTag: string;
  cseq: number;
}

export declare interface SipClient {
  on(event: "invite", listener: (call: IncomingCall) => void): this;
  on(event: "bye", listener: (callId: string) => void): this;
  emit(event: "invite", call: IncomingCall): boolean;
  emit(event: "bye", callId: string): boolean;
}

export class SipClient extends EventEmitter {
  private socket: TLSSocket | null = null;
  private state: SipRegistrationState = "unregistered";
  private framer = new SipStreamFramer();
  private dialogs = new Map<string, Dialog>();

  getState(): SipRegistrationState {
    return this.state;
  }

  /** The local address of the registered TLS socket — used as the SDP answer's connection address. */
  getLocalAddress(): string {
    return this.socket?.localAddress ?? "0.0.0.0";
  }

  async register(): Promise<void> {
    if (!config.sip.extension || !config.sip.password) {
      throw new Error("SIP_EXTENSION / SIP_PASSWORD not configured.");
    }

    this.state = "registering";
    const callId = generateCallId();
    const fromTag = generateTag();

    await new Promise<void>((resolve, reject) => {
      this.socket = connect(
        { host: config.sip.proxyHost, port: config.sip.proxyTlsPort },
        () => {
          if (!this.socket) return reject(new Error("socket not created"));
          const localAddress = this.socket.localAddress ?? "0.0.0.0";
          const localPort = this.socket.localPort ?? 0;

          const firstRequest = buildRegister({
            host: config.sip.proxyHost,
            port: config.sip.proxyTlsPort,
            localAddress,
            localPort,
            extension: config.sip.extension,
            callId,
            fromTag,
            branch: generateBranch(),
            cseq: 1,
          });
          this.socket.write(firstRequest);

          this.socket.once("data", (chunk) => {
            const challengeResponse = parseResponse(chunk.toString());
            if (challengeResponse.status !== 401 && challengeResponse.status !== 407) {
              if (challengeResponse.status === 200) {
                this.state = "registered";
                this.attachPersistentListener();
                resolve();
              } else {
                this.state = "failed";
                reject(new Error(`REGISTER failed: ${challengeResponse.status} ${challengeResponse.reason}`));
              }
              return;
            }

            const authHeaderName = challengeResponse.status === 401 ? "www-authenticate" : "proxy-authenticate";
            const challenge = parseDigestChallenge(challengeResponse.headers[authHeaderName] ?? "");
            const authorization = buildAuthorizationHeader({
              username: config.sip.extension,
              password: config.sip.password,
              method: "REGISTER",
              uri: `sip:${config.sip.proxyHost}`,
              challenge,
              cnonce: generateTag(),
            });

            const authedRequest = buildRegister({
              host: config.sip.proxyHost,
              port: config.sip.proxyTlsPort,
              localAddress,
              localPort,
              extension: config.sip.extension,
              callId,
              fromTag,
              branch: generateBranch(),
              cseq: 2,
              authorization,
            });
            this.socket?.write(authedRequest);

            this.socket?.once("data", (finalChunk) => {
              const finalResponse = parseResponse(finalChunk.toString());
              if (finalResponse.status === 200) {
                this.state = "registered";
                this.attachPersistentListener();
                resolve();
              } else {
                this.state = "failed";
                reject(new Error(`REGISTER failed after auth: ${finalResponse.status} ${finalResponse.reason}`));
              }
            });
          });
        },
      );

      this.socket.on("error", (err) => {
        this.state = "failed";
        reject(err);
      });
    });
  }

  /** After registration, keep listening for inbound requests (INVITE/ACK/BYE) using proper framing. */
  private attachPersistentListener(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners("data");
    this.socket.on("data", (chunk) => {
      for (const raw of this.framer.push(chunk)) {
        this.handleInboundMessage(raw);
      }
    });
  }

  private handleInboundMessage(raw: string): void {
    // Responses to requests we sent start with "SIP/2.0"; everything else
    // is an incoming request from the proxy (INVITE, ACK, BYE, ...).
    if (raw.startsWith("SIP/2.0")) return;

    let request: ParsedRequest;
    try {
      request = parseRequest(raw);
    } catch {
      return;
    }

    switch (request.method) {
      case "INVITE":
        this.handleInvite(request);
        break;
      case "ACK":
        // UAS never ACKs its own 200 OK — this is the caller's ACK to
        // ours, and it needs no reply. Silently consumed.
        break;
      case "BYE":
        this.handleBye(request);
        break;
      default:
        break;
    }
  }

  private handleInvite(request: ParsedRequest): void {
    const callId = request.headers["call-id"] ?? generateCallId();
    const localTag = generateTag();
    let answered = false;

    this.dialogs.set(callId, { request, localTag, cseq: 1 });

    const call: IncomingCall = {
      callId,
      remoteSdp: request.body,
      callerId: extractCallerId(request.headers["from"] ?? ""),
      answer: (localSdp: string) => {
        if (answered) return;
        answered = true;
        const response = buildResponse({
          status: 200,
          reason: "OK",
          request,
          localTag,
          contact: `sip:${config.sip.extension}@${this.socket?.localAddress ?? "0.0.0.0"}:${this.socket?.localPort ?? 0}`,
          body: localSdp,
        });
        this.socket?.write(response);
      },
      reject: (status = 486, reason = "Busy Here") => {
        if (answered) return;
        answered = true;
        this.dialogs.delete(callId);
        const response = buildResponse({ status, reason, request, localTag });
        this.socket?.write(response);
      },
    };

    this.emit("invite", call);
  }

  private handleBye(request: ParsedRequest): void {
    const callId = request.headers["call-id"] ?? "";
    const response = buildResponse({ status: 200, reason: "OK", request });
    this.socket?.write(response);
    this.dialogs.delete(callId);
    this.emit("bye", callId);
  }

  /** Sends an in-dialog request (BYE/REFER) to the caller using the dialog recorded at INVITE time. */
  private sendInDialog(callId: string, method: string, extraHeaders?: string[], body?: string): boolean {
    const dialog = this.dialogs.get(callId);
    if (!dialog || !this.socket) return false;

    dialog.cseq += 1;
    const { request, localTag } = dialog;
    const remoteUri = extractUri(request.headers["contact"] ?? request.headers["from"] ?? "");
    const ourAor = extractUri(request.headers["to"] ?? "");

    const message = buildDialogRequest({
      method,
      requestUri: remoteUri,
      from: `<${ourAor}>;tag=${localTag}`,
      to: request.headers["from"] ?? "",
      callId,
      cseq: dialog.cseq,
      localAddress: this.socket.localAddress ?? "0.0.0.0",
      localPort: this.socket.localPort ?? 0,
      branch: generateBranch(),
      extraHeaders,
      body,
    });
    this.socket.write(message);
    return true;
  }

  /** Hangs up an active call we answered (sends BYE). */
  hangupCall(callId: string): boolean {
    const sent = this.sendInDialog(callId, "BYE");
    if (sent) this.dialogs.delete(callId);
    return sent;
  }

  /** Blind-transfers an active call to another extension on the same proxy (sends REFER). */
  transferCall(callId: string, targetExtension: string): boolean {
    const referTo = `sip:${targetExtension}@${config.sip.proxyHost}`;
    return this.sendInDialog(callId, "REFER", [`Refer-To: <${referTo}>`]);
  }

  deregister(): void {
    this.socket?.destroy();
    this.socket = null;
    this.state = "unregistered";
    this.dialogs.clear();
  }
}
