export const mixToMono = (channels: Float32Array[]) => {
  if (channels.length === 0) return new Float32Array();
  if (channels.length === 1) return channels[0];

  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] || 0;
    mono[i] = sum / channels.length;
  }
  return mono;
};

export const resampleMono = (
  input: Float32Array,
  srcSampleRate: number,
  dstSampleRate: number
) => {
  if (!input?.length) return new Float32Array();
  if (srcSampleRate === dstSampleRate) return input;

  const ratio = dstSampleRate / srcSampleRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const t = i / ratio;
    const i0 = Math.floor(t);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = t - i0;
    const v0 = input[i0] || 0;
    const v1 = input[i1] || 0;
    output[i] = v0 + (v1 - v0) * frac;
  }

  return output;
};

export const decodeAudioBlobToMonoFloat32 = async (blob: Blob) => {
  const buffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    const channels: Float32Array[] = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }
    return {
      samples: mixToMono(channels),
      sampleRate: audioBuffer.sampleRate,
    };
  } finally {
    await audioContext.close().catch(() => {});
  }
};

