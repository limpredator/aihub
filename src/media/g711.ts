// G.711 mu-law codec — the standard reference algorithm (ITU-T G.711 /
// the widely-republished Sun g711.c implementation), not a library. No
// native deps, works identically on any platform.

const BIAS = 0x84;
const CLIP = 32635;

// Segment-end table: for a given top byte of the biased sample, which of
// the 8 u-law segments it falls into.
const SEGMENT_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let seg = 0;
    for (let mask = 0x80; mask > 0x01; mask >>= 1) {
      if ((i & mask) !== 0) break;
      seg++;
    }
    table[i] = Math.min(seg, 7);
  }
  return table;
})();

export function linearToMulawSample(sampleIn: number): number {
  let sample = Math.max(-32768, Math.min(32767, sampleIn));
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exponent = SEGMENT_TABLE[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa);
  return ulawByte & 0xff;
}

export function mulawToLinearSample(ulawByteIn: number): number {
  const ulawByte = ~ulawByteIn & 0xff;
  const sign = ulawByte & 0x80;
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
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
