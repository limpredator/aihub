import { config } from "../config.js";

// STUB — signaling only, no media yet. This opens the WSS connection and
// sends REGISTER, but does NOT handle the 401 digest-auth challenge Kamailio
// will reply with, and has no RTP/media path at all.
//
// Media is the real open decision: softhone's WSS clients are browsers, so
// they get WebRTC (RTCPeerConnection, ICE, DTLS-SRTP) for free. A Node
// service has none of that built in — the options are a Node WebRTC stack
// (e.g. node-webrtc/wrtc, mediasoup) to register the same way softhone does,
// or registering as a plain SIP/TLS endpoint like the native Linphone
// clients (:5061) and handling raw RTP instead, which is a simpler media
// path but a different signaling route than the rest of this file assumes.
// Pick one before building past this stub — see research-ai-receptionist.md
// (AudioSocket vs ExternalMedia) for the equivalent decision on CerdikPBX's
// own Asterisk, though that doc doesn't apply directly here since this
// path goes through Kamailio/rtpengine, not Asterisk.

export type SipRegistrationState = "unregistered" | "registering" | "registered" | "failed";

export class SipClient {
  private socket: WebSocket | null = null;
  private state: SipRegistrationState = "unregistered";

  getState(): SipRegistrationState {
    return this.state;
  }

  async register(): Promise<void> {
    if (!config.sip.extension || !config.sip.password) {
      throw new Error("SIP_EXTENSION / SIP_PASSWORD not configured.");
    }

    this.state = "registering";
    const url = `wss://${config.sip.proxyHost}:${config.sip.proxyWssPort}`;
    this.socket = new WebSocket(url, "sip");

    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error("socket not created"));
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error(`failed to connect to ${url}`)));
    });

    // TODO: send REGISTER, handle 401 digest challenge with SIP_PASSWORD,
    // resend with Authorization header. Until this is implemented,
    // getState() will report "registering" indefinitely — do not treat
    // that as a working registration.
    console.warn("[sip] connected to proxy but REGISTER flow is not yet implemented — not actually registered.");
  }

  deregister(): void {
    this.socket?.close();
    this.socket = null;
    this.state = "unregistered";
  }
}
