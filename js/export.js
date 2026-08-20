// Offline export via WebCodecs.
//
// The realtime path (MediaRecorder) plays the edit back and records the screen,
// so a 30 second video takes 30 seconds and any hitch shows up as a dropped
// frame. This path renders frame by frame with no clock attached: every frame
// is drawn, encoded, and muxed deliberately, so the output is frame-exact and
// usually finishes well ahead of realtime.

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm';

// setTimeout(0) is clamped to ~4-6ms by the browser, which at 30fps is a fifth
// of the frame budget spent doing nothing. A MessageChannel round trip is a
// real macrotask with no clamp - measured at 0.07ms against 5.9ms.
const channel = new MessageChannel();
const nextTask = () => new Promise((res) => {
  channel.port1.onmessage = () => res();
  channel.port2.postMessage(0);
});

export function fastExportSupported() {
  return typeof window.VideoEncoder === 'function' &&
    typeof window.AudioEncoder === 'function' &&
    typeof window.VideoFrame === 'function';
}

export class Cancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'Cancelled';
  }
}

/** First H.264 profile/level this machine will actually encode at this size. */
async function pickVideoConfig(width, height, bitrate, fps) {
  const candidates = [
    'avc1.640034', 'avc1.640033', 'avc1.640032',
    'avc1.4d0034', 'avc1.4d0032',
    'avc1.42003e', 'avc1.42001f',
  ];
  for (const codec of candidates) {
    const config = {
      codec, width, height, bitrate, framerate: fps,
      avc: { format: 'avc' },
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Bounce the music down to a flat buffer covering just the edit. */
async function renderMusic(audioBuffer, tStart, tEnd, volume) {
  const sr = audioBuffer.sampleRate;
  const frames = Math.max(1, Math.round((tEnd - tStart) * sr));
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const ctx = new OfflineAudioContext(channels, frames, sr);

  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain);
  gain.connect(ctx.destination);
  src.start(0, tStart, tEnd - tStart);

  return ctx.startRendering();
}

async function encodeAudio(encoder, rendered) {
  const sr = rendered.sampleRate;
  const channels = rendered.numberOfChannels;
  const total = rendered.length;
  const block = 4096;

  const data = [];
  for (let c = 0; c < channels; c++) data.push(rendered.getChannelData(c));

  for (let offset = 0; offset < total; offset += block) {
    const count = Math.min(block, total - offset);
    const planar = new Float32Array(count * channels);
    for (let c = 0; c < channels; c++) {
      planar.set(data[c].subarray(offset, offset + count), c * count);
    }
    const chunk = new AudioData({
      format: 'f32-planar',
      sampleRate: sr,
      numberOfFrames: count,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sr) * 1e6),
      data: planar,
    });
    encoder.encode(chunk);
    chunk.close();
    if (encoder.encodeQueueSize > 16) await nextTask();
  }
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas      already sized to the output
 * @param {(t:number)=>Promise<void>} o.drawAt  paint the frame for song-time t
 * @returns {Promise<Blob>} an MP4
 */
export async function renderFast({
  canvas, fps = 30, tStart, tEnd, audioBuffer, volume = 1, bitrate = 12_000_000,
  drawAt, onProgress = () => {}, shouldCancel = () => false,
}) {
  const width = canvas.width;
  const height = canvas.height;

  onProgress(0, 'Preparing encoder…');
  const videoConfig = await pickVideoConfig(width, height, bitrate, fps);
  if (!videoConfig) throw new Error(`No H.264 encoder available for ${width}×${height}.`);

  let Muxer, ArrayBufferTarget;
  try {
    ({ Muxer, ArrayBufferTarget } = await import(MUXER_URL));
  } catch {
    throw new Error(
      'Could not load the MP4 muxer. It comes from a CDN, so the fast exporter ' +
      'needs a connection the first time.'
    );
  }

  const music = audioBuffer ? await renderMusic(audioBuffer, tStart, tEnd, volume) : null;
  const audioConfig = music
    ? {
        codec: 'mp4a.40.2',
        sampleRate: music.sampleRate,
        numberOfChannels: music.numberOfChannels,
        bitrate: 192_000,
      }
    : null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    video: { codec: 'avc', width, height },
    ...(audioConfig
      ? {
          audio: {
            codec: 'aac',
            sampleRate: audioConfig.sampleRate,
            numberOfChannels: audioConfig.numberOfChannels,
          },
        }
      : {}),
  });

  let failure = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  videoEncoder.configure(videoConfig);

  let audioEncoder = null;
  if (audioConfig) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    audioEncoder.configure(audioConfig);
  }

  const cleanup = () => {
    try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch {}
    try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch {}
  };

  try {
    const totalFrames = Math.max(1, Math.round((tEnd - tStart) * fps));
    const frameDur = Math.round(1e6 / fps);

    for (let i = 0; i < totalFrames; i++) {
      if (shouldCancel()) throw new Cancelled();
      if (failure) throw failure;

      await drawAt(tStart + i / fps);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: frameDur,
      });
      // A keyframe every two seconds keeps seeking responsive on upload.
      videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      // Let the encoder drain rather than queueing the whole video into RAM.
      // Depth 8 measured fastest; deeper queues did not help because the
      // encoder itself, not the queueing, is the ceiling.
      while (videoEncoder.encodeQueueSize > 8) {
        await nextTask();
        if (failure) throw failure;
      }
      if (i % 5 === 0) onProgress((i / totalFrames) * 0.92, 'Rendering…');
    }

    onProgress(0.94, 'Encoding audio…');
    if (audioEncoder && music) await encodeAudio(audioEncoder, music);

    onProgress(0.97, 'Finishing file…');
    await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    if (failure) throw failure;

    muxer.finalize();
    onProgress(1, 'Done');
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    cleanup();
  }
}
