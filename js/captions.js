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

/* --------------------------------------------------------- word model --- */

/** Stable 0..1 from a string - so "random" choices don't flicker per frame. */
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const STOPWORDS = new Set(
  ('a an the and or but if so of to in on at by for with from as is am are was were be been ' +
   'it its i me my you your he she they we us them this that these those do did done get got ' +
   'not no yes up out off over just like all can will would could should').split(' ')
);

/**
 * Words for a caption, each with its own time.
 *
 * Real word timestamps are used when Whisper supplied them. If the text has
 * since been edited the counts stop matching, so times are re-spread evenly -
 * better than showing stale timings against the wrong words.
 */
export function wordsOf(cap) {
  const parts = cap.text.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];

  const src = cap.words && cap.words.length === parts.length ? cap.words : null;
  const span = Math.max(0.001, cap.end - cap.start);

  return parts.map((raw, i) => {
    // *asterisks* force the accent face on a word.
    const forced = /^\*.+\*$/.test(raw);
    const text = forced ? raw.slice(1, -1) : raw;
    return {
      text,
      forced,
      start: src ? src[i].start : cap.start + (span * i) / parts.length,
      end: src ? src[i].end : cap.start + (span * (i + 1)) / parts.length,
    };
  });
}

/** Should this word use the accent face? */
function isAccent(word, capId, i, rate) {
  if (word.forced) return true;
  if (rate <= 0) return false;
  const clean = word.text.toLowerCase().replace(/[^a-z']/g, '');
  if (clean.length < 4 || STOPWORDS.has(clean)) return false;
  return hash01(`${capId}:${i}:${clean}`) < rate;
}

/** Row sizes for the stacked build, e.g. 1-2-1-3 down the frame. */
function rowPattern(kind, count, seed) {
  const rows = [];
  let left = count;
  let i = 0;
  const cycle = kind === 'pairs' ? [2] : [1, 2, 1, 3];
  while (left > 0) {
    let n;
    if (kind === 'random') n = 1 + Math.floor(hash01(`${seed}:${i}`) * 3);
    else n = cycle[i % cycle.length];
    n = Math.min(n, left);
    rows.push(n);
    left -= n;
    i++;
  }
  return rows;
}

/**
 * Paint the active caption. Called from the same draw path as the clips, so
 * whatever appears in the preview is what lands in the exported file.
 */
export function drawCaptions(ctx, captions, t, W, H, style) {
  const cap = captionAt(captions, t);
  if (!cap || !cap.text.trim()) return;

  const fontPx = Math.max(12, Math.round((H * style.size) / 100));
  const maxWidth = W * 0.86;
  const reveal = style.reveal || 'all';

  // Each word carries its own face and its own moment.
  let words = wordsOf(cap).map((w, i) => ({
    ...w,
    accent: isAccent(w, cap.id, i, style.accentRate || 0),
  }));
  if (!words.length) return;

  if (reveal === 'word') {
    // One at a time: the word being sung, or the last one that started.
    let active = null;
    for (const w of words) if (t >= w.start) active = w;
    if (!active) active = words[0];
    words = [active];
  }

  const faceOf = (w) => (w.accent ? style.accentFont : style.mainFont);
  const label = (w) =>
    style.uppercase && !w.accent ? w.text.toUpperCase() : w.text;

  ctx.save();
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const measure = (w, px) => {
    ctx.font = faceOf(w)(px);
    return ctx.measureText(label(w)).width;
  };

  // ---- rows -------------------------------------------------------------
  let rows;
  if (reveal === 'stack') {
    const sizes = rowPattern(style.pattern || '1213', words.length, cap.id);
    rows = [];
    let k = 0;
    for (const n of sizes) rows.push(words.slice(k, (k += n)));
  } else if (reveal === 'word') {
    rows = [words];
  } else {
    // Greedy wrap to the frame width.
    rows = [];
    let cur = [];
    let curW = 0;
    const spaceW = fontPx * 0.28;
    for (const w of words) {
      const ww = measure(w, fontPx);
      if (cur.length && curW + spaceW + ww > maxWidth) {
        rows.push(cur);
        cur = [];
        curW = 0;
      }
      curW += (cur.length ? spaceW : 0) + ww;
      cur.push(w);
    }
    if (cur.length) rows.push(cur);
  }

  // Per-row scale so a long row never runs off the frame.
  const spaceW = fontPx * 0.28;
  const laidOut = rows.map((row) => {
    const widths = row.map((w) => measure(w, fontPx));
    const total = widths.reduce((a, b) => a + b, 0) + spaceW * (row.length - 1);
    const fit = total > maxWidth ? maxWidth / total : 1;
    return { row, widths, total, fit };
  });

  const lineH = fontPx * 1.18;
  const block = laidOut.length * lineH;
  const anchor =
    style.position === 'top' ? H * 0.16 :
    style.position === 'middle' ? H * 0.5 :
    H * 0.80;
  const top = anchor - block / 2 + lineH / 2;

  // Whole-caption pop on entry (skipped per-word modes, which pop individually).
  if (style.pop && reveal === 'all') {
    const p = Math.min(1, (t - cap.start) / 0.13);
    const s = 0.86 + 0.14 * (p * p * (3 - 2 * p));
    ctx.translate(W / 2, anchor);
    ctx.scale(s, s);
    ctx.translate(-W / 2, -anchor);
  }

  if (style.box) {
    const widest = Math.max(...laidOut.map((r) => Math.min(r.total, maxWidth)));
    const padX = fontPx * 0.45;
    const padY = fontPx * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, W / 2 - widest / 2 - padX, top - lineH / 2 - padY,
      widest + padX * 2, block + padY * 2, fontPx * 0.22);
    ctx.fill();
  }

  // ---- draw -------------------------------------------------------------
  laidOut.forEach(({ row, widths, total, fit }, r) => {
    const y = top + r * lineH;
    let x = W / 2 - (total * fit) / 2;

    row.forEach((w, i) => {
      const wpx = widths[i] * fit;
      // In stacked mode a word is invisible until it is sung; the layout is
      // computed for the whole line regardless, so nothing shifts as it fills.
      const visible = reveal === 'stack' ? t >= w.start : true;
      if (visible) {
        const px = fontPx * fit;
        let scale = 1;
        if (style.pop && reveal !== 'all') {
          const p = Math.min(1, Math.max(0, (t - w.start) / 0.13));
          scale = 0.7 + 0.3 * (p * p * (3 - 2 * p));
        }
        ctx.save();
        ctx.translate(x + wpx / 2, y);
        if (scale !== 1) ctx.scale(scale, scale);
        ctx.font = faceOf(w)(px);
        ctx.lineWidth = px * (style.outline / 100);
        ctx.strokeStyle = style.outlineColor;
        ctx.fillStyle = w.accent && style.accentColor ? style.accentColor : style.color;
        if (ctx.lineWidth > 0) ctx.strokeText(label(w), 0, 0);
        ctx.fillText(label(w), 0, 0);
        ctx.restore();
      }
      x += wpx + spaceW * fit;
    });
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

/**
 * A duck-typed AudioBuffer covering just [startSec, endSec], backed by
 * subarrays so nothing is copied. Lets the whole chain - isolation included -
 * run on the trimmed window only.
 */
function sliceBuffer(audioBuffer, startSec, endSec) {
  const sr = audioBuffer.sampleRate;
  const from = Math.max(0, Math.floor(startSec * sr));
  const to = Math.min(audioBuffer.length, Math.ceil(endSec * sr));
  if (to - from < sr * 0.2) return audioBuffer; // too short to be meaningful

  const views = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    views.push(audioBuffer.getChannelData(c).subarray(from, to));
  }
  return {
    sampleRate: sr,
    length: to - from,
    numberOfChannels: views.length,
    duration: (to - from) / sr,
    getChannelData: (c) => views[c],
  };
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
/**
 * Group per-word timestamps into caption lines that follow the phrasing:
 * a new line starts after `perLine` words, or wherever the singer pauses.
 */
export function groupWords(words, perLine, maxGap = 0.7) {
  // Whisper leaves the closing timestamp null on the last word of every chunk,
  // so discarding words without a full pair silently loses one word per chunk
  // boundary - and with it whole stretches of a long track. Infer the end
  // instead, from the next word or a short default.
  const norm = [];
  for (let i = 0; i < words.length; i++) {
    const text = (words[i].text || '').trim();
    const ts = words[i].timestamp || [];
    const start = ts[0];
    if (!text || start == null) continue;

    let end = ts[1];
    if (end == null) {
      let nextStart = null;
      for (let j = i + 1; j < words.length; j++) {
        const t = words[j].timestamp && words[j].timestamp[0];
        if (t != null) { nextStart = t; break; }
      }
      end = nextStart != null ? Math.min(nextStart, start + 1) : start + 0.35;
    }
    if (end <= start) end = start + 0.12;
    norm.push({ text, start, end });
  }
  norm.sort((a, b) => a.start - b.start);

  const lines = [];
  let cur = [];
  for (const wd of norm) {
    if (cur.length && (cur.length >= perLine || wd.start - cur[cur.length - 1].end > maxGap)) {
      lines.push(cur);
      cur = [];
    }
    cur.push(wd);
  }
  if (cur.length) lines.push(cur);

  const out = lines.map((ws, i) => ({
    id: `w${Date.now()}_${i}`,
    text: ws.map((w) => w.text).join(' '),
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    // Kept so the reveal styles can show each word as it is actually sung.
    words: ws.map((w) => ({ start: w.start, end: w.end })),
  }));

  // Keep the list strictly ordered and non-overlapping: a caption whose end
  // lands at or before its start never renders at all, which reads on screen
  // as "it only transcribed some of it".
  for (let i = 0; i < out.length; i++) {
    const next = i + 1 < out.length ? out[i + 1].start : Infinity;
    // A line that vanishes the instant its last word ends flickers, so hold it
    // a moment - but never past the next line or through a long instrumental.
    out[i].end = Math.min(next, out[i].end + 1.2);
    if (out[i].end <= out[i].start) out[i].end = Math.min(next, out[i].start + 0.3);
  }
  return out.filter((c) => c.end > c.start);
}

export async function transcribe(audioBuffer, opts, onStatus) {
  const {
    modelKey = 'base',
    language = '',
    isolate = false,
    wordTiming = true,
    wordsPerLine = 4,
    processing = 'cpu',
    startSec = 0,
    endSec = Infinity,
  } = opts || {};
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

  // WebGPU is far faster, but fp16 on some GPUs is less faithful than plain
  // 8-bit on the CPU, so this is the user's call rather than an auto-upgrade.
  const device = processing === 'gpu' && navigator.gpu ? 'webgpu' : 'wasm';
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

  // Only the part of the song the edit actually uses. On a 3-minute track
  // trimmed to a 15-second hook that is a twelfth of the work.
  const window = sliceBuffer(audioBuffer, startSec, endSec);
  const source = isolate
    ? isolateVocals(window)
    : { data: downmix(window), sampleRate: window.sampleRate };
  const audio = resampleTo16k(source.data, source.sampleRate);

  onStatus({ phase: 'run', message: 'Listening to the vocal…' });

  const genOpts = {
    return_timestamps: wordTiming ? 'word' : true,
    chunk_length_s: 30,
    stride_length_s: 5,
    // Deliberately NOT setting no_repeat_ngram_size / repetition_penalty, and
    // deliberately leaving previous-text conditioning at its default. Those
    // suppress runaway loops but they also forbid a hook from repeating, which
    // is what a chorus is - they cost more in lyric quality than they save.
    // Loops are dealt with after the fact instead, in cleanChunks().
  };
  if (model.multilingual) {
    genOpts.task = 'transcribe';
    if (language) genOpts.language = language;
  }

  let result;
  let usedWordTiming = wordTiming;
  try {
    result = await cachedPipeline(audio, genOpts);
  } catch (err) {
    // Word timestamps need cross-attention alignment heads; not every export
    // has them. Fall back to segment timing rather than failing outright.
    if (!wordTiming) throw err;
    usedWordTiming = false;
    result = await cachedPipeline(audio, { ...genOpts, return_timestamps: true });
  }

  const chunks = (result && result.chunks) || [];
  const raw = usedWordTiming
    ? groupWords(chunks, wordsPerLine)
    : chunks
        .map((c, i) => {
          const ts = c.timestamp || [];
          const start = ts[0] != null ? ts[0] : 0;
          // Same open-ended-chunk problem as the word path: a null end here
          // used to drop the segment entirely.
          let end = ts[1];
          if (end == null) {
            const next = chunks[i + 1] && chunks[i + 1].timestamp;
            end = next && next[0] != null ? next[0] : start + 2;
          }
          return { id: `w${Date.now()}_${i}`, text: (c.text || '').trim(), start, end };
        })
        .filter((c) => c.text && c.end > c.start);

  // Timestamps come back relative to the slice; shift them into song time.
  const offset = window === audioBuffer ? 0 : startSec;
  const shifted = offset
    ? raw.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }))
    : raw;

  return {
    ...cleanChunks(shifted),
    wordTiming: usedWordTiming,
    analysedFrom: offset,
    analysedSeconds: window.duration != null ? window.duration : audioBuffer.duration,
  };
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
  let junkDropped = 0;   // markers and non-speech tags
  let loopDropped = 0;   // the same line arriving back to back

  for (const c of chunks) {
    let text = c.text
      .replace(/>>+/g, ' ')                    // speaker-change markers
      .replace(/[\[(][^\])]*[\])]/g, ' ')      // [Music], (applause), …
      .replace(/[♪♫]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || !/[a-z0-9]/i.test(text)) { dropped++; junkDropped++; continue; }

    const key = keyOf(text);
    if (!key) { dropped++; junkDropped++; continue; }

    // Only BACK-TO-BACK repeats are collapsed. A runaway loop is consecutive by
    // nature, while a chorus comes back later in the song - counting total
    // occurrences would delete the hook, which is usually the line you most
    // want on screen.
    const prev = out[out.length - 1];
    if (prev && keyOf(prev.text) === key) {
      prev.end = Math.max(prev.end, c.end); // absorb, don't repeat
      dropped++;
      loopDropped++;
      continue;
    }
    seen.set(key, (seen.get(key) || 0) + 1);

    out.push({ ...c, text });
  }

  // A loop is repetition; an instrumental is tags and markers. Same empty
  // result, different advice, so tell them apart.
  const total = chunks.length || 1;
  return {
    captions: out,
    dropped,
    junkDropped,
    loopDropped,
    looped: dropped / total > 0.6 && loopDropped > junkDropped,
  };
}
