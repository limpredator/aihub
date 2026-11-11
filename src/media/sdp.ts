// Minimal SDP (RFC 4566) handling — just enough to receive a PCMU/8000
// offer and answer with the same, for a single audio m= line. No video,
// no ICE, no SRTP: the proxy's rtpengine already terminates those
// concerns for the plain-SIP/TLS path.

export interface RemoteAudioEndpoint {
  address: string;
  port: number;
  payloadType: number;
}

/** Parses the remote RTP address/port and the first audio payload type from an SDP offer body. */
export function parseOffer(sdp: string): RemoteAudioEndpoint {
  const lines = sdp.split(/\r\n|\n/);

  let address = "";
  let port = 0;
  let payloadType = 0;

  for (const line of lines) {
    const connectionMatch = line.match(/^c=IN IP4 (\S+)/);
    if (connectionMatch) address = connectionMatch[1];

    const mediaMatch = line.match(/^m=audio (\d+) RTP\/AVP (.+)/);
    if (mediaMatch) {
      port = Number(mediaMatch[1]);
      payloadType = Number(mediaMatch[2].trim().split(" ")[0]);
    }
  }

  if (!address || !port) throw new Error(`SDP offer missing audio connection info: ${sdp}`);
  return { address, port, payloadType };
}

/** Builds a minimal SDP answer offering PCMU/8000 only, on the given local RTP port. */
export function buildAnswer(opts: { localAddress: string; localPort: number; sessionId?: string }): string {
  const sessionId = opts.sessionId ?? Date.now().toString();
  const lines = [
    "v=0",
    `o=aihub ${sessionId} 1 IN IP4 ${opts.localAddress}`,
    "s=aihub",
    `c=IN IP4 ${opts.localAddress}`,
    "t=0 0",
    `m=audio ${opts.localPort} RTP/AVP 0`,
    "a=rtpmap:0 PCMU/8000",
    "a=sendrecv",
  ];
  return lines.join("\r\n") + "\r\n";
}
