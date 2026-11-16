import { createSocket, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";

// Minimal RTP (RFC 3550) over UDP — PCMU/8000, mono, 20ms frames (160
// bytes/packet). No jitter buffer, no RTCP: good enough for a first pass,
// not for lossy links.

const RTP_VERSION = 2;
const PCMU_PAYLOAD_TYPE = 0;
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 160

export interface RtpSessionOptions {
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export class RtpSession extends EventEmitter {
  private socket: Socket;
  private sequence = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private readonly ssrc = Math.floor(Math.random() * 0xffffffff);
  private readonly remoteAddress: string;
  private readonly remotePort: number;

  private readonly readyPromise: Promise<number>;
  private packetsReceived = 0;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(opts: RtpSessionOptions) {
    super();
    this.remoteAddress = opts.remoteAddress;
    this.remotePort = opts.remotePort;
    this.socket = createSocket("udp4");
    this.socket.on("message", (msg) => this.handleInbound(msg));
    this.socket.on("error", (err) => console.error("[rtp] socket error:", err));
    this.readyPromise = new Promise((resolve) => {
      this.socket.once("listening", () => {
        const { address, port } = this.socket.address();
        console.log(`[rtp] listening on ${address}:${port}, expecting media from ${this.remoteAddress}:${this.remotePort}`);
        // If the PBX/rtpengine can't reach us (bad SDP address, Windows
        // Firewall blocking inbound UDP to node.exe, wrong NAT'd port, etc.)
        // zero packets ever arrive — this makes that silent failure visible
        // instead of looking identical to "caller just hasn't spoken yet".
        this.watchdog = setTimeout(() => {
          if (this.packetsReceived === 0) {
            console.warn(
              `[rtp] no inbound RTP packets received after 5s on ${address}:${port} — ` +
                `check Windows Firewall allows inbound UDP to node.exe, and that the PBX/rtpengine can route to this address.`,
            );
          }
        }, 5000);
        resolve(port);
      });
    });
    // localPort 0 lets the OS pick an ephemeral port — read it back via ready().
    this.socket.bind(opts.localPort);
  }

  /** Resolves with the bound local port once the socket is listening. */
  ready(): Promise<number> {
    return this.readyPromise;
  }

  private handleInbound(packet: Buffer): void {
    if (packet.length < 12) return;
    this.packetsReceived++;
    if (this.packetsReceived === 1) {
      console.log("[rtp] first inbound packet received — media path is working");
    }
    const payload = packet.subarray(12);
    this.emit("audio", payload);
  }

  /** Sends one or more 20ms mu-law frames (160 bytes each) as RTP packets. */
  sendMulawFrame(mulawPayload: Buffer): void {
    const header = Buffer.alloc(12);
    header[0] = (RTP_VERSION << 6) | 0; // version=2, padding/extension/CC=0
    header[1] = PCMU_PAYLOAD_TYPE; // marker=0
    header.writeUInt16BE(this.sequence & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);

    this.sequence++;
    this.timestamp += SAMPLES_PER_FRAME;

    const packet = Buffer.concat([header, mulawPayload]);
    this.socket.send(packet, this.remotePort, this.remoteAddress);
  }

  close(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.socket.close();
  }
}
