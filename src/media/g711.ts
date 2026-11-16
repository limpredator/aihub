// G.711 mu-law codec — the standard reference algorithm (ITU-T G.711 /
// the widely-republished Sun g711.c implementation), not a library. No
// native deps, works identically on any platform.

const BIAS = 0x84;

export function mulawToLinearSample(ulawByteIn: number): number {
  const ulawByte = ~ulawByteIn & 0xff;
  const sign = ulawByte & 0x80;
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

// linearToMulawSample used to derive the segment from a bit-math formula
// (via a 256-entry SEGMENT_TABLE), but two independent attempts at that
// formula both produced wrong bytes — confirmed live (2026-11-16): callers
// heard pure static/noise on every outbound TTS response, while inbound
// audio (which only goes through mulawToLinearSample, verified correct
// against Python's audioop as ground truth) decoded and transcribed fine.
// Encoding by exhaustive search against the verified decode function is
// slower (256 candidates/sample) but is correct by construction — it can
// never disagree with mulawToLinearSample, which is the only thing that
// actually matters for this codec's round trip, and 256 * 8000 = ~2M
// ops/sec is trivial for Node.
const DECODE_TABLE = (() => {
  const table = new Int32Array(256);
  for (let b = 0; b < 256; b++) table[b] = mulawToLinearSample(b);
  return table;
})();

export function linearToMulawSample(sampleIn: number): number {
  const sample = Math.max(-32768, Math.min(32767, sampleIn));
  let best = 0;
  let bestDiff = Infinity;
  for (let b = 0; b < 256; b++) {
    const diff = Math.abs(DECODE_TABLE[b] - sample);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = b;
    }
  }
  return best;
}

export function encodeMulaw(pcm16: Int16Array): Buffer {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToMulawSample(pcm16[i]);
  return out;
}

export function decodeMulaw(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = mulawToLinearSample(mulaw[i]);
  return out;
}
