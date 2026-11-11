import { connect, type TLSSocket } from "node:tls";
import { config } from "../config.js";
import {
  buildRegister,
  parseResponse,
  parseDigestChallenge,
  buildAuthorizationHeader,
  generateCallId,
  generateTag,
  generateBranch,
} from "./sipMessage.js";

// Registers over plain SIP/TLS (port 5061) — the same transport the native
// Linphone clients (iPhone/tablet) already use against this proxy in
// production. Deliberately not WSS: that path implies WebRTC media
// (ICE/DTLS-SRTP), which would need a native Node WebRTC stack for no
// benefit here. Media (RTP/G.711) is not implemented yet — this file only
// gets the registration half working.
//
// UNVERIFIED end-to-end: written correctly against RFC 3261/2617, but not
// yet tested against the real proxy — needs a provisioned SIP_EXTENSION/
// SIP_PASSWORD and ring group membership on the PBX side first.
//
// Known simplification: each response is read from a single "data" event,
// which assumes the whole SIP message arrives in one TCP/TLS chunk. That
// usually holds for a REGISTER response (no SDP body) but isn't guaranteed
// — a production version should buffer until it sees the \r\n\r\n header
// terminator (and respect Content-Length) rather than trusting chunk
// boundaries.

export type SipRegistrationState = "unregistered" | "registering" | "registered" | "failed";

export class SipClient {
  private socket: TLSSocket | null = null;
  private state: SipRegistrationState = "unregistered";

  getState(): SipRegistrationState {
    return this.state;
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
              this.state = challengeResponse.status === 200 ? "registered" : "failed";
              return challengeResponse.status === 200 ? resolve() : reject(new Error(`REGISTER failed: ${challengeResponse.status} ${challengeResponse.reason}`));
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

  deregister(): void {
    this.socket?.destroy();
    this.socket = null;
    this.state = "unregistered";
  }
}
