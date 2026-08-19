// Caption rendering, beat-snapped timing, and optional local transcription.
//
// Captions are {id, text, start, end} in timeline seconds - independent of the
// clip slots, because a line usually spans several cuts.

/* ============================================================== drawing == */

import { FFT } from './analysis.js';

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = `${line} ${words[i]}`;
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function captionAt(captions, t) {
  return captions.find((c) => t >= c.start && t < c.end) || null;
}

/**
 * Paint the active caption. Called from the same draw path as the clips, so
 * whatever appears in the preview is what lands in the exported file.
 */
export function drawCaptions(ctx, captions, t, W, H, style) {
  const cap = captionAt(captions, t);
  if (!cap || !cap.text.trim()) return;

  const fontPx = Math.max(12, Math.round((H * style.size) / 100));
  const text = style.uppercase ? cap.text.toUpperCase() : cap.text;

  ctx.save();
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.font = `900 ${fontPx}px "Segoe UI", Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapLines(ctx, text, W * 0.86);
  const lineH = fontPx * 1.16;
  const block = lines.length * lineH;

  // Vertical anchor. Bottom sits above the phone UI, not flush to the edge.
  const anchor =
    style.position === 'top' ? H * 0.16 :
    style.position === 'middle' ? H * 0.5 :
    H * 0.80;
  const cy = anchor - block / 2 + lineH / 2;

  // A short pop keeps the line feeling like it landed on the beat.
  const age = t - cap.start;
  const p = style.pop ? Math.min(1, age / 0.13) : 1;
  const scale = 0.86 + 0.14 * (p * p * (3 - 2 * p));

  ctx.translate(W / 2, anchor);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -anchor);

  if (style.box) {
    let widest = 0;
    for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
    const padX = fontPx * 0.45;
    const padY = fontPx * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(
      ctx,
      W / 2 - widest / 2 - padX,
      cy - lineH / 2 - padY,
      widest + padX * 2,
      block + padY * 2,
      fontPx * 0.22
    );
    ctx.fill();
  }

  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = fontPx * (style.outline / 100);
  ctx.strokeStyle = style.outlineColor;
  ctx.fillStyle = style.color;

  lines.forEach((line, i) => {
    const y = cy + i * lineH;
    if (ctx.lineWidth > 0) ctx.strokeText(line, W / 2, y);
    ctx.fillText(line, W / 2, y);
  });

  ctx.restore();
}

/* =============================================================== timing == */

/** Nearest beat to `t`, if one is within `tol` seconds. */
export function snapToBeat(beats, t, tol = 0.25) {
  if (!beats || !beats.length) return t;
  let best = t;
  let bestD = Infinity;
  for (const b of beats) {
    const d = Math.abs(b - t);
    if (d < bestD) { bestD = d; best = b; }
    if (b > t + tol) break;
  }
  return bestD <= tol ? best : t;
}

/**
 * Lay text lines onto the beat grid, `beatsPerLine` beats each.
 * This is the half of captioning that is normally fiddly and here is exact.
 */
export function distribute(lines, beats, startTime, beatsPerLine, fallbackEnd) {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  if (!clean.length) return [];

  const usable = beats.filter((b) => b >= startTime - 0.001);
  const out = [];

  clean.forEach((text, i) => {
    const startIdx = i * beatsPerLine;
    const endIdx = startIdx + beatsPerLine;
    const start = usable[startIdx];
    if (start == null) return; // ran past the end of the song
    const end = usable[endIdx] != null ? usable[endIdx] : fallbackEnd;
    if (end > start) out.push({ id: `c${Date.now()}_${i}`, text, start, end });
  });
  return out;
}

/* ========================================================= transcription == */

// Multilingual first: English-only variants are markedly more brittle on sung
// vocals, and useless outright on a track that isn't in English.
// Precision is picked per device: fp16 on WebGPU is near-full quality at half
// the download, while on CPU only the 8-bit weights run at a tolerable speed.
// q8 does cost accuracy, which is part of why the first version read badly.
const MODELS = {
  base: { repo: 'Xenova/whisper-base', gpu: 'fp16', cpu: 'q8', multilingual: true },
  small: { repo: 'Xenova/whisper-small', gpu: 'fp16', cpu: 'q8', multilingual: true },
  'large-v3-turbo': {
    repo: 'onnx-community/whisper-large-v3-turbo',
    gpu: 'q4', cpu: 'q4', multilingual: true,
  },
  'tiny.en': { repo: 'Xenova/whisper-tiny.en', gpu: 'fp32', cpu: 'q8', multilingual: false },
  'base.en': { repo: 'Xenova/whisper-base.en', gpu: 'fp16', cpu: 'q8', multilingual: false },
};

/* -------------------------------------------------- vocal isolation ------ */

const ISO_FFT = 2048;
const ISO_HOP = 512;

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Crude vocal isolation, used only to feed the transcriber - never for playback
 * or export.
 *
 * Lead vocals are almost always panned dead centre, so per frequency bin the
 * left and right channels carry near-identical energy; guitars, synths, pads and
 * reverb are spread wider. Keeping the bins where the two channels agree, and
 * band-limiting to the vocal range to drop kick, bass and cymbals, strips a lot
 * of the backing track. It is not source separation - a centred kick still gets
 * through - but it noticeably cleans up what Whisper has to listen to.
 *
 * On a mono file only the band-limiting applies, which still helps.
 */
export function isolateVocals(buffer) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;

  const fft = new FFT(ISO_FFT);
  const win = hann(ISO_FFT);
  const out = new Float32Array(n);
  const norm = new Float32Array(n);

  const lre = new Float32Array(ISO_FFT);
  const lim = new Float32Array(ISO_FFT);
  const rre = new Float32Array(ISO_FFT);
  const rim = new Float32Array(ISO_FFT);

  const loBin = Math.floor((180 * ISO_FFT) / sr);
  const hiBin = Math.ceil((7000 * ISO_FFT) / sr);
  const half = ISO_FFT / 2;

  for (let pos = 0; pos + ISO_FFT <= n; pos += ISO_HOP) {
    for (let i = 0; i < ISO_FFT; i++) {
      lre[i] = L[pos + i] * win[i]; lim[i] = 0;
      rre[i] = R[pos + i] * win[i]; rim[i] = 0;
    }
    fft.transform(lre, lim);
    fft.transform(rre, rim);

    for (let b = 0; b < ISO_FFT; b++) {
      const mirrored = b < half ? b : ISO_FFT - b; // spectrum is symmetric
      const magL = Math.hypot(lre[b], lim[b]);
      const magR = Math.hypot(rre[b], rim[b]);
      const peak = Math.max(magL, magR);

      // 1 when both channels carry the same energy here, 0 when hard-panned.
      // Gated gently: squeezing this too hard leaves near-silence, and Whisper
      // hallucinates loops on silence rather than admitting it heard nothing.
      let w = peak > 1e-9 ? Math.min(magL, magR) / peak : 0;
      w = Math.pow(w, 1.5);
      if (mirrored < loBin || mirrored > hiBin) w *= 0.15;

      lre[b] = ((lre[b] + rre[b]) * 0.5) * w;
      lim[b] = ((lim[b] + rim[b]) * 0.5) * w;
    }

    fft.inverse(lre, lim);
    for (let i = 0; i < ISO_FFT; i++) {
      out[pos + i] += lre[i] * win[i];
      norm[pos + i] += win[i] * win[i];
    }
  }

  for (let i = 0; i < n; i++) if (norm[i] > 1e-6) out[i] /= norm[i];

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 1e-6) {
    const g = 0.95 / peak;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return { data: out, sampleRate: sr };
}

let cachedPipeline = null;
let cachedKey = null;

/** 16 kHz - what Whisper expects. */
function resampleTo16k(mono, sampleRate) {
  const ratio = sampleRate / 16000;
  if (Math.abs(ratio - 1) < 1e-6) return mono;

  const outLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = x | 0;
    const f = x - i0;
    const a = mono[i0] || 0;
    const b = mono[i0 + 1] || 0;
    out[i] = a + (b - a) * f;
  }
  return out;
}

function downmix(audioBuffer) {
  const chans = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < chans; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / chans;
  }
  return mono;
}

/**
 * Transcribe with Whisper, in this tab. The model is fetched from a CDN the
 * first time and then served from the browser cache; the audio itself never
 * leaves the machine.
 *
 * Accuracy warning for callers: Whisper is trained on speech. Sung vocals over
 * a full mix transcribe poorly - treat the result as a draft to correct.
 */
export async function transcribe(audioBuffer, opts, onStatus) {
  const { modelKey = 'base', language = '', isolate = true } = opts || {};
  const model = MODELS[modelKey] || MODELS.base;
  onStatus({ phase: 'load', message: 'Loading transcription library…' });

  let pipeline;
  try {
    ({ pipeline } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm'
    ));
  } catch (err) {
    throw new Error(
      'Could not load the transcription library. It is fetched from a CDN, so ' +
      'this step needs an internet connection the first time.'
    );
  }

  // WebGPU is dramatically faster and makes the bigger models usable at all.
  const device = navigator.gpu ? 'webgpu' : 'wasm';
  const key = `${modelKey}|${device}`;

  if (!cachedPipeline || cachedKey !== key) {
    onStatus({ phase: 'download', message: `Downloading ${model.repo}…`, progress: 0 });
    try {
      cachedPipeline = await pipeline('automatic-speech-recognition', model.repo, {
        dtype: device === 'webgpu' ? model.gpu : model.cpu,
        device,
        progress_callback: (p) => {
          if (p && p.status === 'progress' && p.total) {
            onStatus({
              phase: 'download',
              message: `Downloading model… ${Math.round((p.loaded / p.total) * 100)}%`,
              progress: p.loaded / p.total,
            });
          }
        },
      });
    } catch (err) {
      cachedPipeline = null;
      throw new Error(
        `Could not load ${model.repo}. Larger models need a lot of memory — ` +
        `try a smaller one. (${(err && err.message) || err})`
      );
    }
    cachedKey = key;
  }

  onStatus({
    phase: 'prep',
    message: isolate ? 'Stripping the backing track…' : 'Preparing audio…',
  });
  await new Promise((r) => setTimeout(r, 10)); // let the message paint

  const source = isolate
    ? isolateVocals(audioBuffer)
    : { data: downmix(audioBuffer), sampleRate: audioBuffer.sampleRate };
  const audio = resampleTo16k(source.data, source.sampleRate);

  onStatus({ phase: 'run', message: 'Listening to the vocal…' });

  const genOpts = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    // Whisper feeds its own previous output back in as context. On music that
    // turns one bad guess into an endless loop of the same phrase - the classic
    // ">> >> >>" / "I'm not. I'm not." failure. Cutting the feedback stops it.
    condition_on_prev_tokens: false,
    condition_on_previous_text: false,
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.15,
  };
  if (model.multilingual) {
    genOpts.task = 'transcribe';
    if (language) genOpts.language = language;
  }

  const result = await cachedPipeline(audio, genOpts);

  const chunks = (result && result.chunks) || [];
  const raw = chunks
    .map((c, i) => ({
      id: `w${Date.now()}_${i}`,
      text: (c.text || '').trim(),
      start: c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0,
      end: c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : 0,
    }))
    .filter((c) => c.end > c.start);

  return cleanChunks(raw);
}

/** Normalised form used to spot a line the model is stuck repeating. */
const keyOf = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Strip Whisper's non-speech artefacts and break repetition loops.
 *
 * Subtitle training data leaves it emitting ">>" speaker markers and bracketed
 * tags like [Music], and on a dense instrumental it will lock onto one phrase
 * and repeat it for the whole track. None of that belongs on screen.
 *
 * @returns {{captions:Array, dropped:number, looped:boolean}}
 */
export function cleanChunks(chunks) {
  const seen = new Map();
  const out = [];
  let dropped = 0;

  for (const c of chunks) {
    let text = c.text
      .replace(/>>+/g, ' ')                    // speaker-change markers
      .replace(/[\[(][^\])]*[\])]/g, ' ')      // [Music], (applause), …
      .replace(/[♪♫]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || !/[a-z0-9]/i.test(text)) { dropped++; continue; }

    const key = keyOf(text);
    if (!key) { dropped++; continue; }

    // Same line back to back, or the model stuck on one phrase all track.
    const prev = out[out.length - 1];
    if (prev && keyOf(prev.text) === key) {
      prev.end = Math.max(prev.end, c.end); // absorb, don't repeat
      dropped++;
      continue;
    }
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > 3) { dropped++; continue; }

    out.push({ ...c, text });
  }

  const total = chunks.length || 1;
  return { captions: out, dropped, looped: dropped / total > 0.6 };
}
