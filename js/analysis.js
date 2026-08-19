// Beat / onset analysis. Pure JS, runs on the decoded AudioBuffer in the page.
//
// Pipeline:  stereo -> mono @22.05k -> STFT -> spectral flux onset envelope
//            -> autocorrelation tempo estimate -> phase-locked beat grid.

const ANALYSIS_RATE = 22050;
const FFT_SIZE = 1024;
const HOP = 256; // ~86 frames/sec

// An STFT frame starting at sample f*HOP reports a transient that lands anywhere
// inside its window, so frame times run early. Half a window, plus 23 ms measured
// against synthetic click tracks (bass onsets peak a little after their attack).
const FRAME_LAG = FFT_SIZE / 2 / ANALYSIS_RATE + 0.023;

/* ---------------------------------------------------------------- FFT ---- */

export class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  // In-place iterative radix-2 Cooley-Tukey.
  transform(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = reverseBits(i, this.levels);
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * this.cos[k] + im[l] * this.sin[k];
          const tim = -re[l] * this.sin[k] + im[l] * this.cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /** In-place inverse: conj -> forward -> conj -> scale. */
  inverse(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.transform(re, im);
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] = -im[i] / n;
    }
  }
}

function reverseBits(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y;
}

/* ------------------------------------------------------------ helpers ---- */

function toMono(buffer, targetRate) {
  const chans = buffer.numberOfChannels;
  const len = buffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / chans;
  }
  if (Math.abs(buffer.sampleRate - targetRate) < 1) return mono;

  const ratio = buffer.sampleRate / targetRate;
  const outLen = Math.floor(len / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = x | 0;
    const frac = x - i0;
    const a = mono[i0] || 0;
    const b = mono[i0 + 1] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Log-spaced band edges (bin indices). Summing raw flux across all bins lets
 * broadband noise - hi-hats, which usually sit on the OFFbeat - outweigh a kick
 * that only occupies three bins. Averaging within bands first fixes that.
 */
function makeBands(bins, loHz = 30, hiHz = 11000, count = 24) {
  const edges = [];
  for (let i = 0; i <= count; i++) {
    const hz = loHz * Math.pow(hiHz / loHz, i / count);
    edges.push(Math.min(bins, Math.max(1, Math.round((hz * FFT_SIZE) / ANALYSIS_RATE))));
  }
  const bands = [];
  for (let i = 0; i < count; i++) {
    if (edges[i + 1] > edges[i]) {
      const centerHz = (((edges[i] + edges[i + 1]) / 2) * ANALYSIS_RATE) / FFT_SIZE;
      bands.push({ lo: edges[i], hi: edges[i + 1], weight: 1 + 2 * Math.exp(-centerHz / 200) });
    }
  }
  return bands;
}

/**
 * Half-wave rectified spectral flux, one value per STFT hop.
 *
 * Separate envelopes per drum register, because "where are the hits" has a
 * different answer per instrument: the kick carries the pulse, while hi-hat
 * rolls and snare fills - the fast stuff in drill and trap - live up top and
 * are invisible in a bass-weighted envelope.
 *
 * @returns {{full, low, mid, high}} all Float32Array, one entry per hop.
 */
function onsetEnvelope(mono) {
  const fft = new FFT(FFT_SIZE);
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)); // Hann
  }

  const bins = FFT_SIZE / 2;
  const bands = makeBands(bins);
  const weightSum = bands.reduce((s, b) => s + b.weight, 0);
  const binOf = (hz) => Math.min(bins, Math.max(1, Math.round((hz * FFT_SIZE) / ANALYSIS_RATE)));
  // kick and 808 / snare and clap body / hats, rides and roll transients
  const lowLo = binOf(30), lowHi = binOf(250);
  const midLo = binOf(200), midHi = binOf(2000);
  const highLo = binOf(5000), highHi = binOf(10500);

  const frames = Math.max(0, Math.floor((mono.length - FFT_SIZE) / HOP));
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const rise = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[off + i] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);

    for (let b = 0; b < bins; b++) {
      const mag = Math.log1p(20 * Math.hypot(re[b], im[b]));
      cur[b] = mag;
      const d = mag - prev[b];
      rise[b] = d > 0 ? d : 0;
    }

    let acc = 0;
    for (const band of bands) {
      let sum = 0;
      for (let b = band.lo; b < band.hi; b++) sum += rise[b];
      acc += (sum / (band.hi - band.lo)) * band.weight;
    }
    full[f] = acc / weightSum;

    let lowSum = 0;
    for (let b = lowLo; b < lowHi; b++) lowSum += rise[b];
    low[f] = lowSum / Math.max(1, lowHi - lowLo);

    let midSum = 0;
    for (let b = midLo; b < midHi; b++) midSum += rise[b];
    mid[f] = midSum / Math.max(1, midHi - midLo);

    let highSum = 0;
    for (let b = highLo; b < highHi; b++) highSum += rise[b];
    high[f] = highSum / Math.max(1, highHi - highLo);

    const swap = prev; prev = cur; cur = swap;
  }
  return { full, low, mid, high };
}

/** Subtract a centered moving average so slow loudness changes don't dominate. */
function detrend(env, radius) {
  const n = env.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    const v = env[i] - mean;
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/**
 * Mean onset strength sampled on a constant-tempo grid. Mean (not sum) so grids
 * of different tempi stay comparable.
 */
function gridScore(env, period, offset) {
  let score = 0;
  let hits = 0;
  for (let t = offset; t < env.length; t += period) {
    const i = Math.round(t);
    // small tolerance window - real beats drift a frame or two
    const v = Math.max(env[i - 1] || 0, env[i] || 0, env[i + 1] || 0);
    score += v;
    hits++;
  }
  return hits ? score / hits : 0;
}

/** Best (bpm, offset) pair within a narrow band around `centerBpm`. */
function refineGrid(env, fps, centerBpm) {
  let best = { bpm: centerBpm, offset: 0, score: -1 };
  const lo = centerBpm * 0.97;
  const hi = centerBpm * 1.03;
  const step = Math.max(0.02, centerBpm / 2000);

  for (let bpm = lo; bpm <= hi; bpm += step) {
    const period = (fps * 60) / bpm;
    for (let o = 0; o < period; o += 0.2) {
      const s = gridScore(env, period, o);
      if (s > best.score) best = { bpm, offset: o, score: s };
    }
  }
  return best;
}

const tempoPrior = (bpm) =>
  Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));

function estimateTempo(env, fps, range) {
  const [minBpm, maxBpm] = range;
  const minLag = Math.floor((fps * 60) / maxBpm);
  const maxLag = Math.ceil((fps * 60) / minBpm);
  let best = null;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < env.length; i++) sum += env[i] * env[i + lag];
    sum /= env.length - lag;

    const bpm = (fps * 60) / lag;
    // Prefer tempi near 120 BPM, log-normal weighting (same idea as librosa).
    const score = sum * tempoPrior(bpm);
    if (!best || score > best.score) best = { lag, bpm, score };
  }
  return best;
}

/* --------------------------------------------------------------- main ---- */

/**
 * @returns {{bpm:number, beats:number[], envelope:Float32Array, fps:number,
 *            duration:number, offset:number}}
 */
export function analyze(audioBuffer) {
  const mono = toMono(audioBuffer, ANALYSIS_RATE);
  const raw = onsetEnvelope(mono);
  const fps = ANALYSIS_RATE / HOP;
  const radius = Math.round(fps * 0.35);
  const env = detrend(raw.full, radius);
  const envLow = detrend(raw.low, radius);

  // Kept for cut detection: which register you cut on is a creative choice.
  // A shorter window here so a hi-hat roll stands out against the bar around it
  // rather than being flattened by its own average.
  const drumRadius = Math.round(fps * 0.18);
  const bands = {
    full: env,
    low: envLow,
    mid: detrend(raw.mid, drumRadius),
    high: detrend(raw.high, drumRadius),
  };

  // Phase envelope: bass-led, with some full-band detail so tracks without a
  // kick drum still lock on to something.
  const phaseEnv = new Float32Array(env.length);
  const nl = normFactor(envLow);
  const nf = normFactor(env);
  for (let i = 0; i < env.length; i++) phaseEnv[i] = envLow[i] * nl + 0.35 * env[i] * nf;

  const duration = audioBuffer.duration;
  const base = estimateTempo(env, fps, [60, 200]);

  // Octave check: pick whichever of bpm/2, bpm, bpm*2 phase-locks best, and
  // refine each candidate to sub-frame precision (integer lags are ~1% coarse).
  const candidates = [base.bpm / 2, base.bpm, base.bpm * 2].filter(
    (b) => b >= 60 && b <= 200
  );
  let best = null;
  for (const bpm of candidates) {
    const fit = refineGrid(phaseEnv, fps, bpm);
    // Weight by the tempo prior, plus a nudge toward autocorrelation's pick.
    const weighted = fit.score * tempoPrior(fit.bpm) * (bpm === base.bpm ? 1.05 : 1);
    if (!best || weighted > best.score) {
      best = { bpm: fit.bpm, offset: fit.offset, score: weighted };
    }
  }

  const offset = best.offset / fps + FRAME_LAG;
  const beats = buildGrid(best.bpm, offset, duration);

  return {
    bpm: best.bpm,
    offset,
    beats,
    envelope: phaseEnv,
    bands,
    fps,
    duration,
  };
}

/** 1 / mean, so two envelopes can be added on comparable scales. */
function normFactor(env) {
  let sum = 0;
  for (let i = 0; i < env.length; i++) sum += env[i];
  const mean = sum / (env.length || 1);
  return mean > 1e-9 ? 1 / mean : 0;
}

/** Constant-tempo beat times covering [0, duration]. */
export function buildGrid(bpm, offsetSec, duration) {
  const period = 60 / bpm;
  const beats = [];
  let t = offsetSec;
  while (t > 0) t -= period; // extend backwards to the start of the track
  t += period;
  for (; t < duration; t += period) if (t >= 0) beats.push(t);
  return beats;
}

/**
 * Peak-picked onsets in one drum register.
 *
 * `band`: 'low' kick and 808, 'mid' snare and clap, 'high' hats, rides and
 * rolls, 'full' the whole kit. Cutting on 'high' with a small minGap is what
 * makes a drill hat roll produce a burst of fast cuts.
 */
export function pickOnsets(analysis, opts = {}) {
  const { band = 'full', sensitivity = 1.4, minGapSec = 0.18 } = opts;
  const { fps, duration } = analysis;
  const env = (analysis.bands && analysis.bands[band]) || analysis.envelope;
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= env.length || 1;
  let sd = 0;
  for (let i = 0; i < env.length; i++) sd += (env[i] - mean) ** 2;
  sd = Math.sqrt(sd / (env.length || 1));

  const threshold = mean + sensitivity * sd;
  const minGap = minGapSec * fps;
  const out = [];
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < threshold) continue;
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    if (i - last < minGap) continue;
    last = i;
    const t = i / fps + FRAME_LAG;
    if (t < duration) out.push(t);
  }
  return out;
}
