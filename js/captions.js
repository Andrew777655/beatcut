// Caption rendering, beat-snapped timing, and optional local transcription.
//
// Captions are {id, text, start, end} in timeline seconds - independent of the
// clip slots, because a line usually spans several cuts.

/* ============================================================== drawing == */

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

const MODELS = {
  'tiny.en': 'Xenova/whisper-tiny.en',
  'base.en': 'Xenova/whisper-base.en',
  base: 'Xenova/whisper-base',
};

let cachedPipeline = null;
let cachedModelKey = null;

/** 16 kHz mono Float32 - what Whisper expects. */
function toMono16k(audioBuffer) {
  const chans = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < chans; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / chans;
  }
  const ratio = audioBuffer.sampleRate / 16000;
  if (Math.abs(ratio - 1) < 1e-6) return mono;

  const outLen = Math.floor(len / ratio);
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

/**
 * Transcribe with Whisper, in this tab. The model is fetched from a CDN the
 * first time and then served from the browser cache; the audio itself never
 * leaves the machine.
 *
 * Accuracy warning for callers: Whisper is trained on speech. Sung vocals over
 * a full mix transcribe poorly - treat the result as a draft to correct.
 */
export async function transcribe(audioBuffer, modelKey, onStatus) {
  const model = MODELS[modelKey] || MODELS['base.en'];
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

  if (!cachedPipeline || cachedModelKey !== modelKey) {
    onStatus({ phase: 'download', message: `Downloading ${model}…`, progress: 0 });
    cachedPipeline = await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
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
    cachedModelKey = modelKey;
  }

  onStatus({ phase: 'run', message: 'Listening to the track…' });
  const audio = toMono16k(audioBuffer);

  const result = await cachedPipeline(audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks = (result && result.chunks) || [];
  return chunks
    .map((c, i) => ({
      id: `w${Date.now()}_${i}`,
      text: (c.text || '').trim(),
      start: c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0,
      end: c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : 0,
    }))
    .filter((c) => c.text && c.end > c.start);
}
