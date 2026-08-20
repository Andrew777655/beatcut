import { analyze, buildGrid, pickOnsets } from './analysis.js';
import {
  drawCaptions, captionAt, distribute, snapToBeat, transcribe, wordsOf,
} from './captions.js';
import { FONTS, fontById, fontOptions, loadFont, fontString } from './fonts.js';
import { renderFast, fastExportSupported } from './export.js';

/* ================================================================ state == */

const state = {
  clips: [],            // {id, kind:'image'|'video', el, url, w, h, duration, thumb}
  order: [],            // clip ids, the sequence used on the timeline
  audio: null,          // {buffer, name, peaks}
  analysis: null,       // result of analyze()
  // Times are absolute positions in the song, so trimming is just a window.
  tStart: 0,            // where the edit begins in the song
  tEnd: 0,              // where it ends
  trimEnd: 0,           // the end marker the user set
  segments: [],         // {start, end, clipId, ov}
  captions: [],         // {id, text, start, end} in timeline seconds
  rendering: false,     // offline WebCodecs render in progress
  overrides: {},        // slot index -> per-slot edits, see DEFAULT_OV
  selected: null,       // index of the slot open in the inspector
  selectedCaption: null, // index of the caption open in the Line tab
  duration: 0,          // timeline length in seconds
  playing: false,
  startedAt: 0,         // audioCtx time at t = 0
  playOffset: 0,        // where playback started within the timeline
  cursor: 0,
  exporting: false,
};

let nextId = 1;

// What happens DURING a slot.
const EFFECTS = [
  ['none', 'None'],
  ['punch', 'Punch zoom'],
  ['punchflash', 'Punch + flash'],
  ['flash', 'Flash'],
  ['shake', 'Shake'],
  ['bounce', 'Bounce'],
  ['drift', 'Slow drift in'],
  ['driftout', 'Slow drift out'],
  ['panleft', 'Pan left'],
  ['panright', 'Pan right'],
  ['pulse', 'Pulse'],
  ['tilt', 'Tilt'],
  ['blurin', 'Blur in'],
  ['glitch', 'Glitch'],
];

// What happens BETWEEN two slots.
const TRANSITIONS = [
  ['cut', 'Hard cut'],
  ['dissolve', 'Crossfade'],
  ['fadeblack', 'Dip to black'],
  ['fadewhite', 'Dip to white'],
  ['slideleft', 'Slide left'],
  ['slideright', 'Slide right'],
  ['slideup', 'Slide up'],
  ['whip', 'Whip pan'],
  ['zoomblur', 'Zoom blur'],
  ['wipe', 'Wipe'],
  ['glitchcut', 'Glitch cut'],
];

const resolveEffect = (seg) => (seg.ov && seg.ov.effect) || $('effect').value;
const resolveTransition = (seg) => (seg.ov && seg.ov.transition) || $('transition').value;

function fillSelect(el, list, firstOption) {
  el.innerHTML =
    (firstOption ? `<option value="">${firstOption}</option>` : '') +
    list.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}

// Per-slot edits. `clipId: null` means "whatever the rotation would pick".
const DEFAULT_OV = {
  clipId: null,
  volume: 1,
  inPoint: 0,
  zoom: 1,
  brightness: 100,
  contrast: 100,
  saturate: 100,
  hue: 0,
  mirror: false,
  effect: '',      // '' = follow the global Look setting
  transition: '',  // '' = follow the global Look setting
};

// Every un-edited slot points at this one object, so a stray write here would
// silently change every clip at once. Freeze it: such a bug should throw.
Object.freeze(DEFAULT_OV);

const ovFor = (i) => state.overrides[i] || (state.overrides[i] = { ...DEFAULT_OV });
const isEdited = (ov) =>
  !!ov && Object.keys(DEFAULT_OV).some((k) => ov[k] !== DEFAULT_OV[k]);

/* ================================================================= dom == */

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const sctx = stage.getContext('2d', { alpha: false });
const wave = $('wave');
const wctx = wave.getContext('2d');

/* =============================================================== audio == */

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const master = audioCtx.createGain();
const clipBus = audioCtx.createGain();   // audio coming from video clips
const streamDest = audioCtx.createMediaStreamDestination();

master.gain.value = 0.9;
clipBus.gain.value = 0;
master.connect(audioCtx.destination);
master.connect(streamDest);
clipBus.connect(master);

let musicSource = null;

/* ================================================== media file loading == */

/**
 * @param {'audio'|'media'} target which panel the files arrived on. Dropping a
 *   video on the music panel means "use its soundtrack", not "add a clip".
 */
async function loadFiles(files, target = 'media') {
  const list = [...files];
  const soundtrack =
    target === 'audio'
      ? list.filter((f) => /^(audio|video)\//.test(f.type))
      : list.filter((f) => f.type.startsWith('audio/'));
  const media =
    target === 'audio'
      ? []
      : list.filter((f) => /^(image|video)\//.test(f.type));
  const audio = soundtrack;
  const skipped = list
    .filter((f) => !media.includes(f) && !audio.includes(f))
    .map((f) => f.name);

  // Load in parallel but splice in by selection order - the loaders finish at
  // wildly different speeds, and clip order is the edit.
  const loaded = await Promise.all(
    media.map((f) => (f.type.startsWith('image/') ? loadImage(f) : loadVideo(f)))
  );
  loaded.forEach((clip, i) => {
    if (clip) {
      state.clips.push(clip);
      state.order.push(clip.id);
    } else {
      skipped.push(media[i].name);
    }
  });

  if (media.length) {
    $('mediaState').textContent = skipped.length
      ? `Skipped ${skipped.length}: ${skipped.join(', ')} — this browser can't decode it.`
      : '';
  }

  if (audio.length) await loadAudio(audio[0]);

  renderClipList();
  rebuild();
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const el = new Image();
  el.src = url;

  // `decode()` waits on rasterization and never settles while the tab isn't
  // compositing, which would hang the whole import. `load` has no such tie.
  await new Promise((res) => {
    el.addEventListener('load', res, { once: true });
    el.addEventListener('error', res, { once: true });
    setTimeout(res, 10_000);
  });

  if (!el.naturalWidth) {
    URL.revokeObjectURL(url);
    return null;
  }
  return {
    id: nextId++,
    kind: 'image',
    el,
    url,
    w: el.naturalWidth,
    h: el.naturalHeight,
    duration: Infinity,
    thumb: url,
    name: file.name,
  };
}

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.src = url;
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';

  await new Promise((res) => {
    el.addEventListener('loadedmetadata', res, { once: true });
    el.addEventListener('error', res, { once: true });
    setTimeout(res, 10_000);
  });

  // Phone footage is often HEVC in a .mov, which most browsers won't decode.
  // Better to say so than to silently composite a black rectangle.
  if (!el.videoWidth || !isFinite(el.duration) || el.duration <= 0) {
    URL.revokeObjectURL(url);
    return null;
  }

  // Grab a poster frame for the tile.
  const thumb = await new Promise((res) => {
    const done = () => {
      const c = document.createElement('canvas');
      c.width = 108;
      c.height = 192;
      const cx = c.getContext('2d');
      try {
        drawCover(cx, el, el.videoWidth, el.videoHeight, c.width, c.height, 1, 0, 0);
      } catch { /* first frame not ready - leave it black */ }
      res(c.toDataURL('image/jpeg', 0.7));
    };
    el.addEventListener('seeked', done, { once: true });
    el.currentTime = Math.min(0.1, (el.duration || 1) / 2);
    setTimeout(done, 1500);
  });

  const clip = {
    id: nextId++,
    kind: 'video',
    el,
    url,
    w: el.videoWidth,
    h: el.videoHeight,
    duration: el.duration,
    thumb,
    name: file.name,
    audioNode: null,
  };

  // Route the clip's own audio through the mix so it can be exported too, via a
  // dedicated gain node - per-slot volume rides this, not element.volume, which
  // is unreliable once the element is feeding a MediaElementSource.
  try {
    clip.audioNode = audioCtx.createMediaElementSource(el);
    clip.gain = audioCtx.createGain();
    clip.gain.gain.value = 1;
    clip.audioNode.connect(clip.gain);
    clip.gain.connect(clipBus);
    el.muted = false;
    el.volume = 1;
  } catch { /* some codecs refuse; stays silent */ }

  return clip;
}

async function loadAudio(file) {
  $('audioLabel').textContent = file.name;
  const fromVideo = file.type.startsWith('video/');
  $('analyzeState').textContent = fromVideo ? 'Extracting audio…' : 'Decoding…';

  const buf = await file.arrayBuffer();
  let decoded;
  try {
    // decodeAudioData pulls the audio track straight out of an MP4/WebM/MOV,
    // so a video file needs no special handling beyond a clearer error.
    decoded = await audioCtx.decodeAudioData(buf);
  } catch (err) {
    $('analyzeState').textContent = fromVideo
      ? `Could not extract audio from ${file.name}. Its audio codec may be one ` +
        'this browser cannot decode, or the file may have no audio track.'
      : `Could not decode ${file.name}.`;
    $('audioLabel').textContent = state.audio ? state.audio.name : 'No song loaded';
    console.error('[beatcut] audio decode failed:', err);
    return;
  }

  $('analyzeState').textContent = 'Finding beats…';
  await new Promise((r) => setTimeout(r, 20)); // let the label paint

  const t0 = performance.now();
  const result = analyze(decoded);
  const ms = Math.round(performance.now() - t0);

  state.audio = { buffer: decoded, name: file.name, peaks: computePeaks(decoded, 2000) };
  state.analysis = result;

  // A new song invalidates any old trim window.
  state.tStart = 0;
  state.trimEnd = decoded.duration;
  state.cursor = 0;
  $('trimStart').max = Math.max(0.1, decoded.duration - 0.5).toFixed(2);
  $('trimStart').value = 0;
  $('trimEnd').max = decoded.duration.toFixed(2);
  $('trimEnd').value = decoded.duration;
  $('editLength').value = '0';

  $('bpm').value = result.bpm.toFixed(2);
  $('analyzeState').textContent =
    `${result.beats.length} beats · ${result.bpm.toFixed(1)} BPM · analysed in ${ms} ms`;
  syncLabels();
}

/* ================================================= timeline generation == */

/** The steady tempo grid. Captions snap to this even in drum modes. */
function beatTimes() {
  const a = state.analysis;
  if (!a) return [];
  const nudge = Number($('offset').value) / 1000;
  const bpm = Number($('bpm').value);
  return buildGrid(bpm, a.offset + nudge, a.duration).filter((t) => t > 0);
}

function drumHits() {
  const a = state.analysis;
  if (!a) return [];
  const nudge = Number($('offset').value) / 1000;
  return pickOnsets(a, {
    band: $('drumBand').value,
    sensitivity: Number($('sense').value),
    minGapSec: Number($('minGap').value),
  }).map((t) => t + nudge).filter((t) => t > 0);
}

/** Grid cuts every `per` beats; `per` below 1 interpolates midpoints. */
function gridCuts(beats, per) {
  const cuts = [];
  if (per < 1) {
    for (let i = 0; i < beats.length - 1; i++) {
      cuts.push(beats[i], (beats[i] + beats[i + 1]) / 2);
    }
    if (beats.length) cuts.push(beats[beats.length - 1]);
  } else {
    for (let i = 0; i < beats.length; i += per) cuts.push(beats[i]);
  }
  return cuts;
}

/**
 * Keep every grid cut, add drum hits that aren't crowding one.
 * Accepted hits are collected separately: appending to the array being scanned
 * breaks its sort order, and with it the neighbour lookup.
 */
function mergeCuts(grid, extra, minGap) {
  const g = grid.slice().sort((a, b) => a - b);
  const accepted = [];
  let gi = 0;
  let last = -Infinity;

  for (const t of extra.slice().sort((a, b) => a - b)) {
    while (gi < g.length && g[gi] < t) gi++;
    const before = gi > 0 ? t - g[gi - 1] : Infinity;
    const after = gi < g.length ? g[gi] - t : Infinity;
    if (Math.min(before, after) < minGap) continue; // too close to a grid cut
    if (t - last < minGap) continue;                // too close to a kept hit
    accepted.push(t);
    last = t;
  }
  return g.concat(accepted).sort((a, b) => a - b);
}

/** The moment each caption word is sung - a cut per word. */
function wordCutTimes() {
  const out = [];
  const minGap = Number($('minGap').value);
  let last = -Infinity;
  for (const cap of state.captions) {
    for (const w of wordsOf(cap)) {
      if (w.start - last < minGap) continue;
      out.push(w.start);
      last = w.start;
    }
  }
  return out.sort((a, b) => a - b);
}

/** Show only the controls the chosen beat source actually uses. */
function syncModeFields() {
  const mode = $('mode').value;
  const usesDrums = mode === 'onsets' || mode === 'hybrid';
  const usesWords = mode === 'words' || mode === 'gridwords';

  $('senseField').hidden = !usesDrums;
  $('drumBandField').hidden = !usesDrums;
  $('minGapField').hidden = !(usesDrums || usesWords);
  $('bpmField').hidden = mode === 'onsets' || mode === 'words';

  const note = $('wordCutNote');
  if (usesWords && !state.captions.length) {
    note.hidden = false;
    note.textContent =
      'No captions yet — add some in section 5 or run auto-transcribe, ' +
      'otherwise there are no word times to cut on.';
  } else if (usesWords) {
    note.hidden = false;
    const words = state.captions.reduce((n, c) => n + wordsOf(c).length, 0);
    note.textContent = `Cutting on ${words} words from ${state.captions.length} caption lines.`;
  } else {
    note.hidden = true;
  }
}

function cutTimes() {
  const a = state.analysis;
  if (!a) return [];
  const mode = $('mode').value;
  const minGap = Number($('minGap').value);

  if (mode === 'onsets') return drumHits();
  if (mode === 'words') return wordCutTimes();

  const cuts = gridCuts(beatTimes(), Number($('beatsPerCut').value));
  if (mode === 'hybrid') return mergeCuts(cuts, drumHits(), minGap);
  if (mode === 'gridwords') return mergeCuts(cuts, wordCutTimes(), minGap);
  return cuts;
}

function rebuild() {
  const maxClips = Number($('maxClips').value);
  const songEnd = state.audio ? state.audio.buffer.duration : 0;
  const from = clamp(state.tStart, 0, Math.max(0, songEnd - 0.2));
  // A length preset just drives the end marker; the marker is the source of truth.
  const preset = Number($('editLength').value);
  const wanted = preset > 0 ? from + preset : (state.trimEnd || songEnd);
  const until = clamp(wanted, from + 0.2, songEnd);
  state.trimEnd = until;
  if ($('trimEnd').max !== String(songEnd)) $('trimEnd').max = songEnd || 100;
  $('trimEnd').value = until;

  const cuts = cutTimes().filter((t) => t > from + 0.06 && t < until - 0.06);

  const order = state.order.filter((id) => state.clips.some((c) => c.id === id));
  state.segments = [];

  state.tStart = from;
  if (!order.length || !state.audio) {
    state.tEnd = until;
    buildWaveLayer();
    drawWave();
    updateUi();
    return;
  }

  const bounds = [from, ...cuts, until];
  const count = maxClips > 0 ? Math.min(maxClips, bounds.length - 1) : bounds.length - 1;
  const alive = new Set(state.clips.map((c) => c.id));

  for (let i = 0; i < count; i++) {
    const ov = state.overrides[i];
    // A slot pinned to a clip that has since been deleted falls back to the
    // rotation instead of rendering nothing.
    if (ov && ov.clipId != null && !alive.has(ov.clipId)) ov.clipId = null;
    state.segments.push({
      start: bounds[i],
      end: bounds[i + 1],
      clipId: (ov && ov.clipId) || order[i % order.length],
      ov: ov || DEFAULT_OV,
    });
  }
  if (state.selected != null && state.selected >= count) state.selected = null;

  state.tEnd = state.segments.length
    ? state.segments[state.segments.length - 1].end
    : until;

  buildWaveLayer();
  drawWave();
  renderTimeline();
  syncInspector();
  updateUi();
  if (!state.playing) drawFrame(state.cursor);
}

function segmentAt(t) {
  const segs = state.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < segs[mid].start) hi = mid - 1;
    else if (t >= segs[mid].end) lo = mid + 1;
    else return segs[mid];
  }
  return segs.length && t >= state.tEnd ? segs[segs.length - 1] : segs[0] || null;
}

/* ================================================================ draw == */

/** Cover-fit draw about the frame centre, with rotation and mirroring. */
function drawCover(ctx, src, sw, sh, W, H, scale, dx, dy, rot, mirror) {
  if (!sw || !sh) return;
  const s = Math.max(W / sw, H / sh) * scale;
  const w = sw * s;
  const h = sh * s;
  ctx.save();
  ctx.translate(W / 2 + dx, H / 2 + dy);
  if (rot) ctx.rotate(rot);
  if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/**
 * Geometry an effect contributes at time `t` within `seg`.
 * Everything is relative: scale multiplies, dx/dy add, flash is an overlay.
 */
function effectParams(seg, t) {
  const dt = Math.max(0, t - seg.start);
  const len = Math.max(0.001, seg.end - seg.start);
  const p = Math.min(1, dt / len); // 0..1 through the slot
  const k = Number($('intensity').value) / 100;
  const out = { scale: 1, dx: 0, dy: 0, rot: 0, blur: 0, flash: 0, glitch: 0 };

  switch (resolveEffect(seg)) {
    case 'punch':
      out.scale = 1 + 0.14 * k * Math.exp(-dt / 0.11);
      break;
    case 'punchflash':
      out.scale = 1 + 0.14 * k * Math.exp(-dt / 0.11);
      out.flash = 0.5 * k * Math.exp(-dt / 0.07);
      break;
    case 'flash':
      out.flash = 0.5 * k * Math.exp(-dt / 0.07);
      break;
    case 'shake':
      out.dx = Math.sin(dt * 90) * 26 * k * Math.exp(-dt / 0.09);
      out.dy = Math.cos(dt * 71) * 26 * k * Math.exp(-dt / 0.09);
      out.scale = 1 + 0.04 * k; // hide the edges the shake exposes
      break;
    case 'drift':
      out.scale = 1 + 0.06 * k * p;
      break;
    case 'driftout':
      out.scale = 1 + 0.06 * k * (1 - p);
      break;
    case 'panleft':
      out.scale = 1 + 0.08 * k;
      out.dx = 0.05 * k * (0.5 - p) * 2 * -260;
      break;
    case 'panright':
      out.scale = 1 + 0.08 * k;
      out.dx = 0.05 * k * (0.5 - p) * 2 * 260;
      break;
    case 'bounce':
      out.scale = 1 + 0.12 * k * Math.exp(-dt / 0.22) * Math.cos(dt * 26);
      break;
    case 'pulse':
      out.scale = 1 + 0.05 * k * Math.sin(p * Math.PI);
      break;
    case 'tilt':
      out.rot = 0.06 * k * Math.exp(-dt / 0.16);
      out.scale = 1 + 0.09 * k; // rotation would otherwise show corners
      break;
    case 'blurin':
      out.blur = 26 * k * Math.exp(-dt / 0.12);
      out.scale = 1 + 0.05 * k * Math.exp(-dt / 0.12);
      break;
    case 'glitch':
      out.glitch = k * Math.exp(-dt / 0.1);
      out.scale = 1 + 0.03 * k;
      break;
    default:
      break; // 'none'
  }
  return out;
}

/**
 * Paint one slot. `over` lets a transition nudge the same slot without the
 * effect layer knowing: {alpha, dx, dy, scaleMul, blur}.
 */
function renderSlot(seg, t, over, W, H) {
  const clip = state.clips.find((c) => c.id === seg.clipId);
  if (!clip) return null;

  const ov = seg.ov || DEFAULT_OV;
  const e = effectParams(seg, t);
  const sw = clip.kind === 'video' ? clip.el.videoWidth || clip.w : clip.w;
  const sh = clip.kind === 'video' ? clip.el.videoHeight || clip.h : clip.h;

  const scale = ov.zoom * e.scale * (over.scaleMul || 1);
  const dx = e.dx + (over.dx || 0);
  const dy = e.dy + (over.dy || 0);
  const blur = Math.max(e.blur, over.blur || 0);

  const filters = [];
  const grade = cssFilter(ov);
  if (grade !== 'none') filters.push(grade);
  if (blur > 0.3) filters.push(`blur(${blur.toFixed(1)}px)`);

  try {
    sctx.save();
    if (over.alpha != null) sctx.globalAlpha = clamp(over.alpha, 0, 1);
    sctx.filter = filters.length ? filters.join(' ') : 'none';
    drawCover(sctx, clip.el, sw, sh, W, H, scale, dx, dy, e.rot, ov.mirror);

    // Glitch: re-stamp a few horizontal slices, offset and channel-shifted.
    if (e.glitch > 0.02) {
      const slices = 5;
      for (let i = 0; i < slices; i++) {
        const y = (i / slices) * H + ((Math.sin(t * 37 + i) + 1) / 2) * (H / slices) * 0.4;
        const h = (H / slices) * 0.35;
        const off = Math.sin(t * 53 + i * 2.1) * 70 * e.glitch;
        sctx.save();
        sctx.beginPath();
        sctx.rect(0, y, W, h);
        sctx.clip();
        sctx.globalCompositeOperation = 'screen';
        drawCover(sctx, clip.el, sw, sh, W, H, scale, dx + off, dy, e.rot, ov.mirror);
        sctx.restore();
      }
    }
    sctx.restore();
  } catch {
    sctx.restore();
  }
  return e;
}

let lastSegment = null;

function drawFrame(t) {
  const W = stage.width;
  const H = stage.height;
  sctx.filter = 'none';
  sctx.globalAlpha = 1;
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, W, H);

  const seg = segmentAt(t);
  if (!seg) return;
  const clip = state.clips.find((c) => c.id === seg.clipId);
  if (!clip) return;

  if (seg !== lastSegment) {
    onSegmentEnter(seg, clip, t);
    lastSegment = seg;
  }

  const i = state.segments.indexOf(seg);
  const prev = i > 0 ? state.segments[i - 1] : null;
  const trans = resolveTransition(seg);
  const td = Math.min(
    Number($('transLen').value) / 1000,
    (seg.end - seg.start) * 0.9
  );
  const dt = t - seg.start;

  let e;
  if (prev && trans !== 'cut' && td > 0.01 && dt < td) {
    e = drawTransition(trans, dt / td, prev, seg, t, W, H);
  } else {
    e = renderSlot(seg, t, {}, W, H);
  }

  sctx.filter = 'none';
  sctx.globalAlpha = 1;

  if (e && e.flash > 0.003) {
    sctx.fillStyle = `rgba(255,255,255,${Math.min(e.flash, 0.9)})`;
    sctx.fillRect(0, 0, W, H);
  }

  // Captions go through the same canvas as everything else, so the preview and
  // the exported file cannot drift apart.
  if ($('capOn').checked && state.captions.length) {
    // Only one caption is on screen at a time, so its style can be resolved here.
    drawCaptions(sctx, state.captions, t, W, H, captionStyle(captionAt(state.captions, t)));
  }

  // Guides are an editing aid, so they must not reach the file.
  if (!state.exporting && !state.rendering) drawSafeZones(W, H);

  // Keep short videos looping inside a long segment, back to their in-point.
  const ov = seg.ov || DEFAULT_OV;
  if (clip.kind === 'video' && state.playing && clip.el.duration) {
    if (clip.el.currentTime >= clip.el.duration - 0.06) {
      clip.el.currentTime = Math.min(ov.inPoint, Math.max(0, clip.el.duration - 0.05));
      clip.el.play().catch(() => {});
    }
  }
}

/**
 * Composite the outgoing and incoming slots. `p` runs 0..1.
 * The outgoing slot is sampled at its final instant - its video element is
 * already paused, so it holds that frame.
 */
function clipped(x, y, w, h, fn) {
  sctx.save();
  sctx.beginPath();
  sctx.rect(x, y, w, h);
  sctx.clip();
  const r = fn();
  sctx.restore();
  return r;
}

/**
 * Push one slot off while the next pushes in.
 * axis 'x' or 'y'; dir 0 = new content enters from the far edge, 1 = from the near edge.
 */
function slide(prev, seg, pt, t, ease, W, H, axis, dir, blur = 0) {
  const span = axis === 'x' ? W : H;
  const shown = span * ease; // how much of the incoming slot is visible
  const outOff = (dir ? 1 : -1) * ease * span;
  const inOff = dir ? -(span - shown) : span - shown;
  const key = axis === 'x' ? 'dx' : 'dy';

  const outRect = dir ? [shown, 0, W - shown, H] : [0, 0, W - shown, H];
  const inRect = dir ? [0, 0, shown, H] : [W - shown, 0, shown, H];
  const vOutRect = dir ? [0, shown, W, H - shown] : [0, 0, W, H - shown];
  const vInRect = dir ? [0, 0, W, shown] : [0, H - shown, W, shown];

  const [ox, oy, ow, oh] = axis === 'x' ? outRect : vOutRect;
  const [ix, iy, iw, ih] = axis === 'x' ? inRect : vInRect;

  clipped(ox, oy, ow, oh, () => renderSlot(prev, pt, { [key]: outOff, blur }, W, H));
  return clipped(ix, iy, iw, ih, () => renderSlot(seg, t, { [key]: inOff, blur }, W, H));
}

function drawTransition(kind, p, prev, seg, t, W, H) {
  const pt = prev.end - 0.001;
  const ease = p * p * (3 - 2 * p); // smoothstep
  let e = null;

  switch (kind) {
    case 'dissolve':
      renderSlot(prev, pt, {}, W, H);
      e = renderSlot(seg, t, { alpha: ease }, W, H);
      break;

    case 'fadeblack':
      if (p < 0.5) renderSlot(prev, pt, { alpha: 1 - p * 2 }, W, H);
      else e = renderSlot(seg, t, { alpha: (p - 0.5) * 2 }, W, H);
      break;

    case 'fadewhite':
      if (p < 0.5) renderSlot(prev, pt, {}, W, H);
      else e = renderSlot(seg, t, {}, W, H);
      sctx.filter = 'none';
      sctx.globalAlpha = 1;
      sctx.fillStyle = `rgba(255,255,255,${1 - Math.abs(0.5 - p) * 2})`;
      sctx.fillRect(0, 0, W, H);
      break;

    // Sliding layers must be clipped to the strip they occupy. Clips are
    // cover-fit and usually overflow the frame, so an unclipped incoming layer
    // just covers everything and the slide reads as a plain cut.
    case 'slideleft':
      e = slide(prev, seg, pt, t, ease, W, H, 'x', 0);
      break;

    case 'slideright':
      e = slide(prev, seg, pt, t, ease, W, H, 'x', 1);
      break;

    case 'slideup':
      e = slide(prev, seg, pt, t, ease, W, H, 'y', 0);
      break;

    case 'whip':
      // Motion blur peaks mid-swipe, like a fast camera pan.
      e = slide(prev, seg, pt, t, ease, W, H, 'x', 0, (1 - Math.abs(0.5 - p) * 2) * 45);
      break;

    case 'zoomblur':
      renderSlot(prev, pt, { scaleMul: 1 + ease * 0.7, alpha: 1 - ease, blur: ease * 22 }, W, H);
      e = renderSlot(seg, t, { scaleMul: 1.5 - 0.5 * ease, alpha: ease, blur: (1 - ease) * 14 }, W, H);
      break;

    case 'wipe':
      renderSlot(prev, pt, {}, W, H);
      sctx.save();
      sctx.beginPath();
      sctx.rect(0, 0, W * ease, H);
      sctx.clip();
      e = renderSlot(seg, t, {}, W, H);
      sctx.restore();
      break;

    case 'glitchcut': {
      e = renderSlot(seg, t, {}, W, H);
      const strength = 1 - p;
      for (let i = 0; i < 6; i++) {
        const y = ((i + Math.sin(t * 40 + i)) / 6) * H;
        const h = (H / 6) * 0.5;
        sctx.save();
        sctx.beginPath();
        sctx.rect(0, y, W, h);
        sctx.clip();
        sctx.globalAlpha = strength;
        renderSlot(prev, pt, { dx: Math.sin(t * 61 + i) * 90 * strength }, W, H);
        sctx.restore();
      }
      break;
    }

    default:
      e = renderSlot(seg, t, {}, W, H);
  }
  return e;
}

// Fractions of the frame each app covers with its own UI. Deliberately a little
// generous - being slightly too cautious costs nothing, a covered caption costs
// the whole video.
const SAFE_ZONES = {
  shorts: { name: 'YouTube Shorts', top: 0.06, bottom: 0.20, left: 0.03, right: 0.14 },
  tiktok: { name: 'TikTok', top: 0.09, bottom: 0.22, left: 0.03, right: 0.17 },
  reels: { name: 'Instagram Reels', top: 0.10, bottom: 0.21, left: 0.03, right: 0.15 },
};

function safeZoneFor(key) {
  if (key === 'all') {
    const all = Object.values(SAFE_ZONES);
    return {
      name: 'All platforms',
      top: Math.max(...all.map((z) => z.top)),
      bottom: Math.max(...all.map((z) => z.bottom)),
      left: Math.max(...all.map((z) => z.left)),
      right: Math.max(...all.map((z) => z.right)),
    };
  }
  return SAFE_ZONES[key] || null;
}

/** Preview-only overlay. Never called while rendering the output file. */
function drawSafeZones(W, H) {
  const zone = safeZoneFor($('safeZone').value);
  if (!zone) return;

  const x0 = W * zone.left;
  const x1 = W * (1 - zone.right);
  const y0 = H * zone.top;
  const y1 = H * (1 - zone.bottom);

  sctx.save();
  sctx.filter = 'none';
  sctx.globalAlpha = 1;

  // Dim everything the platform will cover.
  sctx.fillStyle = 'rgba(0,0,0,0.45)';
  sctx.fillRect(0, 0, W, y0);
  sctx.fillRect(0, y1, W, H - y1);
  sctx.fillRect(0, y0, x0, y1 - y0);
  sctx.fillRect(x1, y0, W - x1, y1 - y0);

  sctx.strokeStyle = 'rgba(55,226,213,0.9)';
  sctx.lineWidth = Math.max(2, W / 400);
  sctx.setLineDash([W / 60, W / 90]);
  sctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

  sctx.setLineDash([]);
  sctx.fillStyle = 'rgba(55,226,213,0.95)';
  sctx.font = `600 ${Math.round(H * 0.018)}px system-ui, sans-serif`;
  sctx.textAlign = 'left';
  sctx.textBaseline = 'top';
  sctx.fillText(`${zone.name} — keep it inside`, x0 + W * 0.012, y0 + H * 0.008);
  sctx.restore();
}

function cssFilter(ov) {
  const parts = [];
  if (ov.brightness !== 100) parts.push(`brightness(${ov.brightness}%)`);
  if (ov.contrast !== 100) parts.push(`contrast(${ov.contrast}%)`);
  if (ov.saturate !== 100) parts.push(`saturate(${ov.saturate}%)`);
  if (ov.hue !== 0) parts.push(`hue-rotate(${ov.hue}deg)`);
  return parts.length ? parts.join(' ') : 'none';
}

function onSegmentEnter(seg, clip, t) {
  for (const c of state.clips) {
    if (c.kind === 'video' && c !== clip) c.el.pause();
  }
  if (clip.kind !== 'video') return;

  const ov = seg.ov || DEFAULT_OV;
  if (clip.gain) clip.gain.gain.value = ov.volume;

  // Offline rendering positions clips itself, frame by frame, and waits for the
  // seek to land. Touching currentTime here would start a second seek that is
  // still in flight when the frame is grabbed.
  if (state.rendering) return;

  clip.el.currentTime = videoTimeFor(seg, clip, t);
  if (state.playing) clip.el.play().catch(() => {});
  else clip.el.pause();
}

/** Where inside a clip the playhead sits for a given moment of the slot. */
function videoTimeFor(seg, clip, t) {
  const ov = seg.ov || DEFAULT_OV;
  const dur = clip.el.duration || 0;
  if (!dur) return 0;
  const into = Math.max(0, t - seg.start);
  const start = Math.min(ov.inPoint, Math.max(0, dur - 0.05));
  return start + (into % Math.max(0.05, dur - start));
}

/** Park every video needed for time `t` on the right frame, and wait for it. */
async function seekClipsFor(t, fps) {
  const seg = segmentAt(t);
  if (!seg) return;

  const needed = [seg];
  // Mid-transition the outgoing slot is on screen too, so it also has to be
  // sitting on the correct frame.
  const i = state.segments.indexOf(seg);
  const td = Math.min(Number($('transLen').value) / 1000, (seg.end - seg.start) * 0.9);
  if (i > 0 && resolveTransition(seg) !== 'cut' && t - seg.start < td) {
    needed.push(state.segments[i - 1]);
  }

  const waits = [];
  for (const s of needed) {
    const clip = state.clips.find((c) => c.id === s.clipId);
    if (!clip || clip.kind !== 'video') continue;
    const target = videoTimeFor(s, clip, s === seg ? t : s.end - 0.001);
    if (Math.abs(clip.el.currentTime - target) < 0.5 / fps) continue;

    clip.el.currentTime = target;
    waits.push(new Promise((res) => {
      const done = () => res();
      clip.el.addEventListener('seeked', done, { once: true });
      setTimeout(done, 400); // never wedge the render on one bad seek
    }));
  }
  if (waits.length) await Promise.all(waits);
}

/* ============================================================ waveform == */

function computePeaks(buffer, buckets) {
  const data = buffer.getChannelData(0);
  const per = Math.floor(data.length / buckets) || 1;
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const start = i * per;
    for (let j = 0; j < per; j += 4) {
      const v = Math.abs(data[start + j] || 0);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

// Peaks and cut markers only change when the audio or the timeline changes, so
// they are cached. Redrawing 2000 bars every animation frame starves the
// real-time recorder and shows up as dropped frames in the export.
const WAVE_H = 70;
let waveLayer = null;

function buildWaveLayer() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = wave.clientWidth || 800;
  const H = WAVE_H;

  wave.width = cssW * dpr;
  wave.height = H * dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!state.audio) { waveLayer = null; return; }

  waveLayer = document.createElement('canvas');
  waveLayer.width = cssW * dpr;
  waveLayer.height = H * dpr;
  const lc = waveLayer.getContext('2d');
  lc.setTransform(dpr, 0, 0, dpr, 0, 0);

  const peaks = state.audio.peaks;
  const dur = state.audio.buffer.duration;

  lc.fillStyle = '#39414f';
  for (let x = 0; x < cssW; x++) {
    const p = peaks[Math.floor((x / cssW) * peaks.length)] || 0;
    const h = Math.max(1, p * H * 0.85);
    lc.fillRect(x, (H - h) / 2, 1, h);
  }

  lc.strokeStyle = 'rgba(255,45,120,0.85)';
  lc.lineWidth = 1;
  lc.beginPath();
  for (const seg of state.segments) {
    const x = Math.round((seg.start / dur) * cssW) + 0.5;
    lc.moveTo(x, 0);
    lc.lineTo(x, H);
  }
  lc.stroke();

  // Grey out the parts of the song the edit doesn't use.
  const x0 = (state.tStart / dur) * cssW;
  const x1 = (state.tEnd / dur) * cssW;
  lc.fillStyle = 'rgba(12,13,16,0.72)';
  if (x0 > 0) lc.fillRect(0, 0, x0, H);
  if (x1 < cssW) lc.fillRect(x1, 0, cssW - x1, H);
  lc.strokeStyle = 'rgba(55,226,213,0.9)';
  lc.lineWidth = 2;
  lc.beginPath();
  lc.moveTo(x0, 0); lc.lineTo(x0, H);
  lc.moveTo(x1, 0); lc.lineTo(x1, H);
  lc.stroke();
}

function drawWave() {
  const cssW = wave.clientWidth || 800;
  const H = WAVE_H;
  wctx.clearRect(0, 0, cssW, H);
  if (!waveLayer || !state.audio) return;

  wctx.drawImage(waveLayer, 0, 0, cssW, H);

  const px = (state.cursor / state.audio.buffer.duration) * cssW;
  wctx.strokeStyle = '#37e2d5';
  wctx.lineWidth = 2;
  wctx.beginPath();
  wctx.moveTo(px, 0);
  wctx.lineTo(px, H);
  wctx.stroke();
}

/* ============================================================ playback == */

/** Browsers start the context suspended until a real gesture; wait it out. */
async function ensureAudio() {
  if (audioCtx.state !== 'running') await audioCtx.resume();
}

async function play(from = state.cursor) {
  if (!state.audio || !state.segments.length) return;
  stopAudio();
  if (from >= state.tEnd - 0.05 || from < state.tStart) from = state.tStart;

  // Resume BEFORE reading currentTime, or the clock we sync to is frozen.
  await ensureAudio();

  musicSource = audioCtx.createBufferSource();
  musicSource.buffer = state.audio.buffer;
  musicSource.connect(master);
  musicSource.start(0, from);

  state.playing = true;
  state.playOffset = from;
  state.startedAt = audioCtx.currentTime;
  lastSegment = null;
  $('btnPlay').textContent = '❚❚';
}

function stopAudio() {
  if (musicSource) {
    try { musicSource.stop(); } catch { /* already stopped */ }
    musicSource.disconnect();
    musicSource = null;
  }
  for (const c of state.clips) if (c.kind === 'video') c.el.pause();
}

function pause() {
  state.cursor = currentTime();
  stopAudio();
  state.playing = false;
  $('btnPlay').textContent = '▶';
}

function currentTime() {
  if (!state.playing) return state.cursor;
  return state.playOffset + (audioCtx.currentTime - state.startedAt);
}

function tick() {
  requestAnimationFrame(tick);
  if (state.playing) {
    const t = currentTime();
    if (t >= state.tEnd) {
      // pause() latches the cursor from the clock, so rewind after it, not before.
      pause();
      state.cursor = state.tStart;
      if (state.exporting) finishExport();
      drawFrame(state.tStart);
      drawWave();
      return;
    }
    state.cursor = t;
    drawFrame(t);
    drawWave();
    markPlayingSlot();
    markActiveCaption();
    // Shown relative to the edit, not to the song.
    $('time').textContent = `${fmt(t - state.tStart)} / ${fmt(editLength())}`;
    if (state.exporting) setExportProgress((t - state.tStart) / editLength());
  }
}
requestAnimationFrame(tick);

/* ============================================================== export == */

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

let recorder = null;
let chunks = [];
let exportMime = '';

let exportWatchdog = null;

/** Offline render: no clock, every frame drawn and encoded deliberately. */
async function startFastExport() {
  const fps = 30;
  state.rendering = true;
  pause();
  lastSegment = null;
  const startedAt = performance.now();

  try {
    const blob = await renderFast({
      canvas: stage,
      fps,
      tStart: state.tStart,
      tEnd: state.tEnd,
      audioBuffer: state.audio.buffer,
      volume: Number($('volume').value),
      drawAt: async (t) => {
        await seekClipsFor(t, fps);
        drawFrame(t);
      },
      onProgress: (p, label) => {
        setExportProgress(p);
        $('exportTitle').textContent = label || 'Rendering…';
      },
      shouldCancel: () => cancelRequested,
    });

    saveBlob(blob, 'mp4');
    // Encoder throughput varies enormously between machines, so report what it
    // actually managed rather than promising a figure.
    const secs = (performance.now() - startedAt) / 1000;
    const speed = editLength() / secs;
    $('renderStatus').textContent =
      `Rendered in ${secs.toFixed(1)}s · ${speed.toFixed(2)}× realtime`;
    $('exportOverlay').hidden = true;
  } finally {
    state.rendering = false;
    lastSegment = null;
    state.cursor = state.tStart;
    drawFrame(state.cursor);
  }
}

function saveBlob(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `beatcut-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

let cancelRequested = false;

async function startExport() {
  if (!state.segments.length) return;

  cancelRequested = false;
  showExportOverlay();

  // Video-clip audio is played by the media elements, which an offline render
  // has no way to capture - that case has to go through the realtime path.
  const clipAudioOn = Number($('clipAudio').value) > 0;
  const wantFast = $('exportMode').value !== 'realtime';

  if (wantFast && fastExportSupported() && !clipAudioOn) {
    $('exportHint').textContent =
      'Rendering offline — every frame is drawn and encoded deliberately, so ' +
      'nothing can be dropped. Speed depends on your encoder.';
    try {
      await startFastExport();
      return;
    } catch (err) {
      if (err && err.name === 'Cancelled') {
        $('exportOverlay').hidden = true;
        return;
      }
      // Anything else: fall back rather than leaving them with nothing.
      console.warn('[beatcut] fast export failed, falling back to realtime:', err);
      $('exportHint').textContent =
        `Fast export failed (${(err && err.message) || err}) — recording in realtime instead.`;
    }
  } else if (wantFast && clipAudioOn) {
    $('exportHint').textContent =
      'Clip audio is on, which only the realtime recorder can capture. Recording in realtime.';
  }

  try {
    exportMime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    if (!exportMime) {
      throw new Error(
        'This browser cannot record video. Chrome or Edge will export MP4 directly.'
      );
    }

    pause();
    await ensureAudio();
    if (audioCtx.state !== 'running') {
      throw new Error('The audio engine is suspended. Click anywhere on the page, then retry.');
    }

    state.cursor = state.tStart;
    lastSegment = null;
    drawFrame(state.tStart);

    const fps = 30;
    const videoStream = stage.captureStream(fps);
    const audioTracks = streamDest.stream.getAudioTracks();
    if (!videoStream.getVideoTracks().length) {
      throw new Error('Could not capture the preview canvas.');
    }
    const mixed = new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);

    chunks = [];
    recorder = new MediaRecorder(mixed, {
      mimeType: exportMime,
      videoBitsPerSecond: 12_000_000,
      audioBitsPerSecond: 192_000,
    });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = saveRecording;
    recorder.onerror = (e) => exportFailed(e.error || new Error('Recording failed.'));

    state.exporting = true;
    setExportProgress(0);
    recorder.start(500);
    await play(state.tStart);

    if (!state.playing) throw new Error('Playback did not start.');

    // If the clock hasn't moved after a few seconds something is wedged;
    // say so instead of leaving a modal stuck at 0% forever.
    clearTimeout(exportWatchdog);
    exportWatchdog = setTimeout(() => {
      // Relative to the trim window - an edit starting 20s into the song is
      // perfectly healthy at cursor 24.
      if (state.exporting && state.cursor - state.tStart < 0.2) {
        exportFailed(new Error('Rendering stalled at the start. Reload the page and retry.'));
      }
    }, 4000);
  } catch (err) {
    exportFailed(err);
  }
}

function showExportOverlay() {
  $('exportOverlay').hidden = false;
  $('exportTitle').textContent = 'Rendering…';
  $('exportHint').hidden = false;
  $('exportHint').textContent =
    'Recording happens in real time. Keep this tab visible and don\'t switch windows.';
  $('exportProgress').hidden = false;
  $('exportError').hidden = true;
  $('exportError').textContent = '';
  $('btnCancelExport').textContent = 'Cancel';
  setExportProgress(0);
}

function exportFailed(err) {
  clearTimeout(exportWatchdog);
  state.exporting = false;
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    try { recorder.stop(); } catch { /* already gone */ }
  }
  recorder = null;
  chunks = [];
  pause();

  $('exportTitle').textContent = 'Export failed';
  $('exportHint').hidden = true;
  $('exportProgress').hidden = true;
  $('exportError').hidden = false;
  $('exportError').textContent = String((err && err.message) || err);
  $('btnCancelExport').textContent = 'Close';
  console.error('[beatcut] export failed:', err);
}

function finishExport() {
  if (!state.exporting) return;
  state.exporting = false;
  clearTimeout(exportWatchdog);
  setTimeout(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, 350); // let the tail of the audio flush into the muxer
}

function cancelExport() {
  cancelRequested = true; // stops the offline render at its next frame
  state.exporting = false;
  clearTimeout(exportWatchdog);
  chunks = [];
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  recorder = null;
  pause();
  $('exportOverlay').hidden = true;
}

function saveRecording() {
  clearTimeout(exportWatchdog);
  if (!chunks.length) {
    exportFailed(new Error('The recorder produced no data. Try a shorter edit or reload.'));
    return;
  }
  const blob = new Blob(chunks, { type: exportMime });
  const ext = exportMime.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `beatcut-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);

  chunks = [];
  recorder = null;
  $('exportOverlay').hidden = true;
}

function setExportProgress(p) {
  const pct = Math.round(clamp(p, 0, 1) * 100);
  $('exportBar').style.width = `${pct}%`;
  $('exportPct').textContent = `${pct}%`;
}

/* ============================================================ timeline == */

const TL_PX_PER_SEC = 130;

/** Thumbnail, number and edited dot for one slot - cheap enough to call live. */
function paintSlot(el, i) {
  const seg = state.segments[i];
  if (!el || !seg) return;
  const clip = state.clips.find((c) => c.id === seg.clipId);
  el.style.backgroundImage = clip ? `url(${clip.thumb})` : '';
  el.innerHTML =
    `<span class="n">${i + 1}</span>` +
    (isEdited(state.overrides[i]) ? '<span class="edited" title="Edited"></span>' : '');
  el.title = clip ? `${i + 1} · ${clip.name}` : `${i + 1}`;
}

// Slots have a minimum width, so x is not simply time * scale. The lane is
// measured as it is built and captions are mapped through the same table,
// otherwise the two rows would drift apart on fast edits.
let tlMap = [];

function timeToX(t) {
  if (!tlMap.length) return 0;
  const first = tlMap[0];
  const last = tlMap[tlMap.length - 1];
  if (t <= first.start) return 0;
  if (t >= last.end) return last.x + last.w;
  for (const s of tlMap) {
    if (t < s.end) return s.x + ((t - s.start) / (s.end - s.start)) * s.w;
  }
  return last.x + last.w;
}

function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  tlMap = [];

  if (!state.segments.length) {
    tl.innerHTML = '<div class="tl-empty">Load a song and some clips to build the timeline.</div>';
    renderCapLane();
    return;
  }

  state.segments.forEach((seg, i) => {
    const el = document.createElement('div');
    el.className = 'tl-slot';
    el.dataset.i = i;
    // Constant pixels-per-second, so a fast slot always looks shorter than a
    // slow one no matter how long the song is.
    const w = Math.max(26, (seg.end - seg.start) * TL_PX_PER_SEC);
    el.style.width = `${w}px`;
    const prev = tlMap[tlMap.length - 1];
    tlMap.push({ start: seg.start, end: seg.end, x: prev ? prev.x + prev.w + 2 : 0, w });
    if (i === state.selected) el.classList.add('selected');
    paintSlot(el, i);

    el.addEventListener('click', () => selectSlot(i, true));

    // Drop a tile from the clip list to swap what plays here.
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/plain')) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      const id = Number(e.dataTransfer.getData('text/plain'));
      if (!state.clips.some((c) => c.id === id)) return;
      ovFor(i).clipId = id;
      selectSlot(i, false);
      rebuild();
    });

    tl.appendChild(el);
  });
  renderCapLane();
  markPlayingSlot();
}

/** Caption blocks, laid on the same x scale as the clips above them. */
function renderCapLane() {
  const lane = $('capLane');
  lane.innerHTML = '';
  const last = tlMap[tlMap.length - 1];
  lane.style.width = last ? `${last.x + last.w}px` : '100%';

  if (!state.captions.length) {
    lane.innerHTML = '<span class="caplane-empty">No captions yet</span>';
    return;
  }

  state.captions.forEach((cap, i) => {
    if (cap.end < state.tStart || cap.start > state.tEnd) return; // outside the edit
    const x = timeToX(cap.start);
    const w = Math.max(18, timeToX(cap.end) - x);
    const el = document.createElement('div');
    el.className = 'cap-block' + (cap.style ? ' styled' : '') +
      (i === state.selectedCaption ? ' selected' : '');
    el.style.left = `${x}px`;
    el.style.width = `${w}px`;
    el.textContent = cap.text;
    el.title = `${fmtMs(cap.start)} → ${fmtMs(cap.end)} · ${cap.text}`;
    el.addEventListener('click', () => selectCaption(i));
    lane.appendChild(el);
  });
}

function selectCaption(i) {
  state.selectedCaption = i;
  const cap = state.captions[i];
  if (cap) {
    state.cursor = clamp(cap.start + 0.01, state.tStart, state.tEnd);
    lastSegment = null;
    if (state.playing) play(state.cursor);
    else { drawFrame(state.cursor); drawWave(); }
  }
  renderCapLane();
  syncLineInspector();
  showPane('line');
}

/** Highlight the slot under the playhead without rebuilding the strip. */
let playingSlot = -1;
function markPlayingSlot() {
  const seg = segmentAt(state.cursor);
  const i = seg ? state.segments.indexOf(seg) : -1;
  if (i === playingSlot) return;
  const tl = $('timeline');
  const prev = tl.children[playingSlot];
  if (prev && prev.classList) prev.classList.remove('playing');
  const now = tl.children[i];
  if (now && now.classList) {
    now.classList.add('playing');
    if (state.playing) now.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  playingSlot = i;
}

function selectSlot(i, seek) {
  state.selected = i;
  if (seek) {
    const seg = state.segments[i];
    if (seg) {
      state.cursor = seg.start + 0.001;
      lastSegment = null;
      if (state.playing) play(state.cursor);
      else { drawFrame(state.cursor); drawWave(); }
    }
  }
  [...$('timeline').children].forEach((el, idx) =>
    el.classList && el.classList.toggle('selected', idx === i)
  );
  syncInspector();
  showPane('slot');
}

/* =========================================================== inspector == */

function syncInspector() {
  const i = state.selected;
  const seg = i != null ? state.segments[i] : null;

  $('inspector').hidden = !seg;
  $('slotEmpty').hidden = !!seg;
  $('tabSlot').disabled = !seg;

  // Pane switching belongs to selectSlot, not here: syncInspector also runs on
  // every rebuild, and changing a Cut setting must not throw you into Slot.
  if (!seg) {
    if ($('tabSlot').classList.contains('is-on')) showPane('cut');
    return;
  }

  const ov = state.overrides[i] || DEFAULT_OV;
  const clip = state.clips.find((c) => c.id === seg.clipId);
  const isVideo = clip && clip.kind === 'video';

  $('inspTitle').textContent = `Slot ${i + 1}`;
  $('inspMeta').textContent =
    `${fmtMs(seg.start)} → ${fmtMs(seg.end)} · ${(seg.end - seg.start).toFixed(2)}s` +
    (clip ? ` · ${clip.name}` : '');

  const sel = $('inspClip');
  sel.innerHTML =
    '<option value="">Auto (follow clip order)</option>' +
    state.clips
      .map((c) => `<option value="${c.id}">${c.kind === 'video' ? '▶' : '◼'} ${c.name}</option>`)
      .join('');
  sel.value = ov.clipId == null ? '' : String(ov.clipId);

  $('inspVolField').hidden = !isVideo;
  $('inspTrimField').hidden = !isVideo;
  if (isVideo) {
    $('inspTrim').max = Math.max(0.1, clip.duration - 0.1).toFixed(1);
    $('inspTrim').value = Math.min(ov.inPoint, clip.duration);
  }

  // Spell out what "Use global" currently resolves to, so it is obvious whether
  // this slot is following the Look panel or overriding it.
  const labelOf = (list, id) => (list.find(([v]) => v === id) || [, id])[1];
  $('inspEffect').options[0].textContent =
    `Use global (${labelOf(EFFECTS, $('effect').value)})`;
  $('inspTransition').options[0].textContent =
    `Use global (${labelOf(TRANSITIONS, $('transition').value)})`;

  $('inspEffect').value = ov.effect;
  $('inspTransition').value = ov.transition;
  $('inspVol').value = Math.round(ov.volume * 100);
  $('inspZoom').value = Math.round(ov.zoom * 100);
  $('inspBright').value = ov.brightness;
  $('inspContrast').value = ov.contrast;
  $('inspSat').value = ov.saturate;
  $('inspHue').value = ov.hue;
  $('inspMirror').checked = ov.mirror;
  syncInspectorLabels();
}

function syncInspectorLabels() {
  $('inspVolVal').textContent = `${$('inspVol').value}%`;
  $('inspTrimVal').textContent = `${Number($('inspTrim').value).toFixed(1)}s`;
  $('inspZoomVal').textContent = `${$('inspZoom').value}%`;
  $('inspBrightVal').textContent = `${$('inspBright').value}%`;
  $('inspContrastVal').textContent = `${$('inspContrast').value}%`;
  $('inspSatVal').textContent = `${$('inspSat').value}%`;
  $('inspHueVal').textContent = `${$('inspHue').value}°`;
}

/** Read the inspector controls back into the selected slot's override. */
function applyInspector() {
  const i = state.selected;
  if (i == null || !state.segments[i]) return;
  const ov = ovFor(i);

  const pick = $('inspClip').value;
  ov.clipId = pick === '' ? null : Number(pick);
  ov.volume = Number($('inspVol').value) / 100;
  ov.inPoint = Number($('inspTrim').value);
  ov.zoom = Number($('inspZoom').value) / 100;
  ov.brightness = Number($('inspBright').value);
  ov.contrast = Number($('inspContrast').value);
  ov.saturate = Number($('inspSat').value);
  ov.hue = Number($('inspHue').value);
  ov.mirror = $('inspMirror').checked;
  ov.effect = $('inspEffect').value;
  ov.transition = $('inspTransition').value;

  syncInspectorLabels();

  const seg = state.segments[i];
  seg.ov = ov; // the slot may have been built before this override existed
  if (ov.clipId != null) seg.clipId = ov.clipId;
  else {
    const order = state.order.filter((id) => state.clips.some((c) => c.id === id));
    if (order.length) seg.clipId = order[i % order.length];
  }

  // Touch only this slot. A full rebuild() here would re-create every timeline
  // node on every slider tick, which stutters badly on a long song.
  paintSlot($('timeline').children[i], i);
  lastSegment = null; // re-enter the slot so a swap or new in-point applies now
  if (!state.playing) drawFrame(state.cursor);
}

const fmtMs = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String((s % 60).toFixed(1)).padStart(4, '0')}`;
};

/* =========================================================== captions == */

/**
 * Resolved style for one caption. A line carrying its own `style` overrides the
 * shared settings field by field; everything it does not name still follows the
 * Text tab, so changing the shared size still moves lines that only overrode a
 * colour.
 */
function captionStyle(cap) {
  const o = (cap && cap.style) || {};
  const pick = (key, fallback) => (o[key] !== undefined ? o[key] : fallback);

  const mainFace = fontById(pick('fontMain', $('capFont').value));
  const accentFace = fontById(pick('fontAccent', $('capAccentFont').value));
  const outlineOn = pick('outlineOn', $('capOutlineOn').checked);

  return {
    size: pick('size', Number($('capSize').value)),
    position: pick('position', $('capPos').value),
    offset: pick('offset', 0),
    outline: outlineOn ? pick('outline', Number($('capOutline').value)) : 0,
    color: pick('color', $('capColor').value),
    accentColor: pick('accentColor', $('capAccentColor').value),
    outlineColor: pick('outlineColor', $('capOutlineColor').value),
    uppercase: pick('uppercase', $('capUpper').checked),
    pop: $('capPop').checked,
    box: $('capBox').checked,
    reveal: pick('reveal', $('capReveal').value),
    pattern: $('capPattern').value,
    accentRate: Number($('capAccent').value) / 100,
    // Passed as functions so the renderer can size each word independently.
    mainFont: (px) => fontString(mainFace, px),
    accentFont: (px) => fontString(accentFace, px),
  };
}

/** Fetch whichever faces are in play, then repaint with them. */
async function applyFonts() {
  const wanted = new Set([$('capFont').value, $('capAccentFont').value]);
  for (const cap of state.captions) {
    if (!cap.style) continue;
    if (cap.style.fontMain) wanted.add(cap.style.fontMain);
    if (cap.style.fontAccent) wanted.add(cap.style.fontAccent);
  }
  $('capFontNote').textContent =
    `${$('capAccentFont').selectedOptions[0].text} lands on the occasional word — ` +
    'set how often below.';

  await Promise.all([...wanted].map((id) => loadFont(fontById(id))));
  if (!state.playing) drawFrame(state.cursor);
}

/** Spread the typed lines across the beat grid. */
function placeCaptions() {
  const beats = beatTimes();
  if (!beats.length) return;
  const lines = $('capText').value.split('\n');
  const startAt = state.cursor > 0.05 ? snapToBeat(beats, state.cursor, 10) : beats[0];
  state.captions = distribute(
    lines,
    beats,
    startAt,
    Number($('capBeats').value),
    state.tEnd || (state.audio ? state.audio.buffer.duration : 0)
  );
  captionsChanged();
}

/**
 * Call after anything edits state.captions. In the word-driven cut modes the
 * captions ARE the cut list, so the timeline has to be rebuilt with them.
 */
function captionsChanged() {
  renderCaptionList();
  // The selected line may not exist any more after a re-transcribe or a clear.
  if (state.selectedCaption != null && !state.captions[state.selectedCaption]) {
    state.selectedCaption = null;
  }
  renderCapLane();
  syncLineInspector();
  const mode = $('mode').value;
  if (mode === 'words' || mode === 'gridwords') {
    syncModeFields();
    rebuild();
  } else if (!state.playing) {
    drawFrame(state.cursor);
  }
}

function renderCaptionList() {
  const list = $('capList');
  list.innerHTML = '';
  state.captions.forEach((cap, i) => {
    const li = document.createElement('li');
    li.dataset.id = cap.id;

    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = fmtMs(cap.start);
    at.title = 'Jump here';
    at.addEventListener('click', () => {
      state.cursor = cap.start + 0.001;
      lastSegment = null;
      if (state.playing) play(state.cursor);
      else { drawFrame(state.cursor); drawWave(); }
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.value = cap.text;
    input.addEventListener('input', () => {
      state.captions[i].text = input.value;
      // Rebuilding the whole list on each keystroke would steal focus, so only
      // the timeline is refreshed when the words drive the cuts.
      const mode = $('mode').value;
      if (mode === 'words' || mode === 'gridwords') rebuild();
      else if (!state.playing) drawFrame(state.cursor);
    });

    const del = document.createElement('button');
    del.className = 'linkish';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', () => {
      state.captions.splice(i, 1);
      captionsChanged();
    });

    li.append(at, input, del);
    list.appendChild(li);
  });
}

/** Highlight whichever caption is on screen. */
let activeCaptionId = null;
function markActiveCaption() {
  const cap = captionAt(state.captions, state.cursor);
  const id = cap ? cap.id : null;
  if (id === activeCaptionId) return;
  activeCaptionId = id;
  for (const li of $('capList').children) {
    li.classList.toggle('active', li.dataset.id === id);
  }
}

/* ------------------------------------------------- per-line inspector -- */

// Style key -> the control that sets it. Written out rather than derived from
// the key: two of the ids don't match their key and a generated name silently
// resolves to null.
const LINE_FIELDS = [
  ['fontMain', 'lnFont', (el) => el.value],
  ['fontAccent', 'lnAccentFont', (el) => el.value],
  ['reveal', 'lnReveal', (el) => el.value],
  ['size', 'lnSize', (el) => Number(el.value)],
  ['position', 'lnPos', (el) => el.value],
  ['offset', 'lnOffset', (el) => Number(el.value)],
  ['outlineOn', 'lnOutlineOn', (el) => el.checked],
  ['outline', 'lnOutline', (el) => Number(el.value)],
  ['color', 'lnColor', (el) => el.value],
  ['accentColor', 'lnAccentColor', (el) => el.value],
  ['outlineColor', 'lnOutlineColor', (el) => el.value],
  ['uppercase', 'lnUpper', (el) => el.checked],
];

function syncLineInspector() {
  const i = state.selectedCaption;
  const cap = i != null ? state.captions[i] : null;

  $('lineInsp').hidden = !cap;
  $('lineEmpty').hidden = !!cap;
  $('tabLine').disabled = !cap;

  if (!cap) {
    if ($('tabLine').classList.contains('is-on')) showPane('text');
    return;
  }

  $('lnTitle').textContent = `Line ${i + 1}`;
  $('lnMeta').textContent =
    `${fmtMs(cap.start)} → ${fmtMs(cap.end)} · ${(cap.end - cap.start).toFixed(2)}s`;
  $('lnText').value = cap.text;

  const on = !!cap.style;
  $('lnOverride').checked = on;
  $('lnFields').hidden = !on;

  // Seed the controls from whatever this line currently resolves to, so turning
  // the override on changes nothing until something is actually moved.
  const s = captionStyle(cap);
  const own = cap.style || {};
  $('lnFont').value = own.fontMain !== undefined ? own.fontMain : $('capFont').value;
  $('lnAccentFont').value =
    own.fontAccent !== undefined ? own.fontAccent : $('capAccentFont').value;
  $('lnReveal').value = s.reveal;

  // A one-word line has nothing to reveal progressively.
  $('lnRevealField').hidden = wordsOf(cap).length < 2;
  $('lnSize').value = s.size;
  $('lnPos').value = s.position;
  $('lnOffset').value = s.offset;
  $('lnOutlineOn').checked = s.outline > 0;
  $('lnOutline').value = s.outline || Number($('capOutline').value);
  $('lnColor').value = s.color;
  $('lnAccentColor').value = s.accentColor;
  $('lnOutlineColor').value = s.outlineColor;
  $('lnUpper').checked = s.uppercase;
  syncLineLabels();
}

function syncLineLabels() {
  $('lnSizeVal').textContent = `${Number($('lnSize').value).toFixed(1)}%`;
  $('lnOutlineVal').textContent = `${$('lnOutline').value}%`;
  $('lnOffsetVal').textContent = `${$('lnOffset').value}%`;
}

function applyLineInspector() {
  const i = state.selectedCaption;
  const cap = i != null ? state.captions[i] : null;
  if (!cap) return;

  if (!$('lnOverride').checked) {
    delete cap.style;
  } else {
    cap.style = {};
    for (const [key, id, read] of LINE_FIELDS) cap.style[key] = read($(id));
  }
  syncLineLabels();
  renderCapLane();
  if (!state.playing) drawFrame(state.cursor);
}

async function runTranscribe() {
  if (!state.audio) return;
  const btn = $('capTranscribe');
  const status = $('capStatus');
  btn.disabled = true;

  try {
    const result = await transcribe(
      state.audio.buffer,
      {
        modelKey: $('capModel').value,
        language: $('capLang').value,
        isolate: $('capIsolate').checked,
        wordTiming: $('capTiming').value === 'word',
        wordsPerLine: Number($('capWords').value),
        processing: $('capProc').value,
        // Only the trimmed window - no point transcribing three minutes of a
        // song for a fifteen second edit.
        startSec: state.tStart,
        endSec: state.tEnd || state.audio.buffer.duration,
      },
      (s) => { status.textContent = s.message; }
    );

    const { captions: cleaned, dropped, looped, wordTiming, analysedSeconds } = result;

    if (!cleaned.length) {
      const advice = $('capIsolate').checked
        ? ' Try a bigger model, or turn off "Strip the backing track first".'
        : ' Try a bigger model, or set the Language explicitly.';
      status.textContent = looped
        ? `The model looped instead of finding words.${advice}`
        : `No clear vocal found — the track read as music.${advice}`;
      return;
    }

    const beats = beatTimes();
    state.captions = cleaned.map((c) => ({
      ...c,
      start: $('capSnap').checked ? snapToBeat(beats, c.start, 0.3) : c.start,
      end: $('capSnap').checked ? snapToBeat(beats, c.end, 0.3) : c.end,
    })).filter((c) => c.end > c.start);

    $('capText').value = state.captions.map((c) => c.text).join('\n');
    captionsChanged();
    status.textContent =
      `${state.captions.length} lines from ${Math.round(analysedSeconds)}s of audio, ` +
      `timed ${wordTiming ? 'per word' : 'per segment'}` +
      (dropped ? `, ${dropped} junk lines removed` : '') +
      ' — expect mistakes on sung vocals; edit them below.';
    if (!state.playing) drawFrame(state.cursor);
  } catch (err) {
    status.textContent = String((err && err.message) || err);
    console.error('[beatcut] transcription failed:', err);
  } finally {
    btn.disabled = false;
  }
}

/* ================================================================== ui == */

function renderClipList() {
  const list = $('clipList');
  list.innerHTML = '';

  state.order.forEach((id, i) => {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip) return;
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.id = id;
    li.innerHTML = `
      <img src="${clip.thumb}" alt="" />
      <span class="idx">${i + 1}</span>
      <span class="kind">${clip.kind === 'video' ? '▶' : '◼'}</span>
      <button class="del" title="Remove">✕</button>`;

    li.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeClip(id);
    });

    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(id));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('over');
      const dragged = Number(e.dataTransfer.getData('text/plain'));
      if (!dragged || dragged === id) return;
      const from = state.order.indexOf(dragged);
      const to = state.order.indexOf(id);
      state.order.splice(from, 1);
      state.order.splice(to, 0, dragged);
      renderClipList();
      rebuild();
    });

    list.appendChild(li);
  });
}

function removeClip(id) {
  const clip = state.clips.find((c) => c.id === id);
  if (clip) {
    if (clip.kind === 'video') clip.el.pause();
    URL.revokeObjectURL(clip.url);
  }
  state.clips = state.clips.filter((c) => c.id !== id);
  state.order = state.order.filter((x) => x !== id);
  lastSegment = null;
  renderClipList();
  rebuild();
}

function updateUi() {
  const ready = state.segments.length > 0;
  $('btnPlay').disabled = !ready;
  $('btnStop').disabled = !ready;
  $('btnExport').disabled = !ready;
  $('stageEmpty').hidden = ready;
  $('time').textContent = `${fmt(state.cursor - state.tStart)} / ${fmt(editLength())}`;

  const a = state.analysis;
  $('readout').textContent = a
    ? `${state.clips.length} clips · ${Number($('bpm').value).toFixed(2)} BPM · ` +
      `${state.segments.length} cuts · ${fmt(editLength())}`
    : 'Load a song to start';
}

function syncLabels() {
  $('senseVal').textContent = Number($('sense').value).toFixed(2);
  $('offsetVal').textContent = `${$('offset').value} ms`;
  $('intensityVal').textContent = `${$('intensity').value}%`;
  $('transLenVal').textContent = `${$('transLen').value} ms`;
  $('minGapVal').textContent = `${Number($('minGap').value).toFixed(2)}s`;
  $('trimStartVal').textContent = fmtMs(Number($('trimStart').value));
  $('trimEndVal').textContent = fmtMs(Number($('trimEnd').value));
  $('editLengthVal').textContent =
    Number($('editLength').value) > 0 ? `${$('editLength').value}s` : 'custom';
  $('capAccentVal').textContent = `${$('capAccent').value}%`;
  $('capSizeVal').textContent = `${Number($('capSize').value).toFixed(1)}%`;
  $('capOutlineVal').textContent = `${$('capOutline').value}%`;
}

function setAspect() {
  const [w, h] = $('aspect').value.split('x').map(Number);
  stage.width = w;
  stage.height = h;
  drawFrame(state.cursor);
}

const editLength = () => Math.max(0, state.tEnd - state.tStart);

const fmt = (s) => {
  s = Math.max(0, s || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ============================================================== events == */

$('btnPlay').addEventListener('click', () => (state.playing ? pause() : play()));
$('btnStop').addEventListener('click', () => {
  pause();
  state.cursor = 0;
  lastSegment = null;
  drawFrame(0);
  drawWave();
});

$('btnShuffle').addEventListener('click', () => {
  for (let i = state.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
  }
  renderClipList();
  rebuild();
});

$('btnClear').addEventListener('click', () => {
  pause();
  for (const c of state.clips) URL.revokeObjectURL(c.url);
  state.clips = [];
  state.order = [];
  lastSegment = null;
  renderClipList();
  rebuild();
});

function toggleFullscreen() {
  const wrap = document.querySelector('.canvas-wrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen().catch(() => {});
}
$('btnFull').addEventListener('click', toggleFullscreen);

$('btnExport').addEventListener('click', startExport);
$('btnCancelExport').addEventListener('click', cancelExport);

$('trimStart').addEventListener('input', () => {
  state.tStart = Number($('trimStart').value);
  syncLabels();
  pause();
  state.cursor = state.tStart;
  lastSegment = null;
  rebuild();
});

$('trimHere').addEventListener('click', () => {
  state.tStart = state.cursor;
  $('trimStart').value = state.tStart;
  $('editLength').value = '0'; // a hand-placed marker is no longer a preset length
  syncLabels();
  rebuild();
});

$('trimEnd').addEventListener('input', () => {
  state.trimEnd = Number($('trimEnd').value);
  $('editLength').value = '0';
  syncLabels();
  pause();
  lastSegment = null;
  rebuild();
});

$('trimEndHere').addEventListener('click', () => {
  state.trimEnd = state.cursor;
  $('trimEnd').value = state.trimEnd;
  $('editLength').value = '0';
  syncLabels();
  rebuild();
});

$('trimReset').addEventListener('click', () => {
  state.tStart = 0;
  state.trimEnd = state.audio ? state.audio.buffer.duration : 0;
  $('trimStart').value = 0;
  $('trimEnd').value = state.trimEnd;
  $('editLength').value = '0';
  state.cursor = 0;
  lastSegment = null;
  syncLabels();
  rebuild();
});

for (const id of ['beatsPerCut', 'mode', 'bpm', 'sense', 'offset', 'maxClips',
                  'editLength', 'drumBand', 'minGap']) {
  $(id).addEventListener('input', () => {
    if (id === 'mode') syncModeFields();
    syncLabels();
    rebuild();
  });
}

for (const id of ['effect', 'transition', 'transLen', 'intensity', 'safeZone']) {
  $(id).addEventListener('input', () => {
    syncLabels();
    if (state.selected != null) syncInspector(); // refresh the "Use global (…)" text
    if (!state.playing) drawFrame(state.cursor);
  });
}

$('btnRandomLook').addEventListener('click', () => {
  // Skip 'none' so every slot actually gets something.
  const pool = EFFECTS.filter(([id]) => id !== 'none').map(([id]) => id);
  for (let i = 0; i < state.segments.length; i++) {
    const ov = ovFor(i);
    ov.effect = pool[Math.floor(Math.random() * pool.length)];
    state.segments[i].ov = ov;
  }
  renderTimeline();
  syncInspector();
  if (!state.playing) drawFrame(state.cursor);
});

const setBpm = (v) => {
  $('bpm').value = clamp(v, 40, 300).toFixed(2);
  rebuild();
};
$('bpmHalf').addEventListener('click', () => setBpm(Number($('bpm').value) / 2));
$('bpmDouble').addEventListener('click', () => setBpm(Number($('bpm').value) * 2));
$('bpmReset').addEventListener('click', () => {
  if (state.analysis) setBpm(state.analysis.bpm);
});

for (const id of ['inspClip', 'inspEffect', 'inspTransition', 'inspVol', 'inspTrim',
                  'inspZoom', 'inspBright', 'inspContrast', 'inspSat', 'inspHue',
                  'inspMirror']) {
  $(id).addEventListener('input', applyInspector);
}

$('inspClose').addEventListener('click', () => {
  state.selected = null;
  [...$('timeline').children].forEach((el) => el.classList && el.classList.remove('selected'));
  syncInspector(); // disables the tab and drops back to Cut
});

$('inspReset').addEventListener('click', () => {
  if (state.selected == null) return;
  state.overrides[state.selected] = { ...DEFAULT_OV };
  syncInspector();
  lastSegment = null;
  rebuild();
});

$('inspApplyAll').addEventListener('click', () => {
  if (state.selected == null) return;
  const src = state.overrides[state.selected];
  if (!src) return;
  // Look only - clip assignment, trim and volume stay per slot.
  for (let i = 0; i < state.segments.length; i++) {
    const ov = ovFor(i);
    ov.zoom = src.zoom;
    ov.brightness = src.brightness;
    ov.contrast = src.contrast;
    ov.saturate = src.saturate;
    ov.hue = src.hue;
    ov.mirror = src.mirror;
    ov.effect = src.effect;
    ov.transition = src.transition;
    state.segments[i].ov = ov;
  }
  rebuild();
});

$('capPlace').addEventListener('click', placeCaptions);
$('capClear').addEventListener('click', () => {
  state.captions = [];
  $('capText').value = '';
  $('capStatus').textContent = '';
  captionsChanged();
});
$('capTranscribe').addEventListener('click', runTranscribe);

$('capTiming').addEventListener('input', () => {
  $('capWordsField').hidden = $('capTiming').value !== 'word';
});

/* ---------------------------------------------------------- tabs ------- */

function showPane(name) {
  for (const btn of $('tabs').children) {
    btn.classList.toggle('is-on', btn.dataset.pane === name);
  }
  for (const pane of document.querySelectorAll('.pane')) {
    pane.classList.toggle('is-on', pane.dataset.pane === name);
  }
  // Each tab keeps its own scroll position rather than inheriting the last.
  document.querySelector('.panes').scrollTop = 0;
}

for (const [, id] of LINE_FIELDS) {
  $(id).addEventListener('input', applyLineInspector);
}
$('lnOverride').addEventListener('input', () => {
  $('lnFields').hidden = !$('lnOverride').checked;
  applyLineInspector();
});
$('lnReset').addEventListener('click', () => {
  $('lnOverride').checked = false;
  $('lnFields').hidden = true;
  applyLineInspector();
  syncLineInspector();
});
$('lnClose').addEventListener('click', () => {
  state.selectedCaption = null;
  renderCapLane();
  syncLineInspector();
});
$('lnText').addEventListener('input', () => {
  const cap = state.captions[state.selectedCaption];
  if (!cap) return;
  cap.text = $('lnText').value;
  renderCapLane();
  renderCaptionList();
  const mode = $('mode').value;
  if (mode === 'words' || mode === 'gridwords') rebuild();
  else if (!state.playing) drawFrame(state.cursor);
});
for (const [btn, delta] of [['lnNudgeL', -0.1], ['lnNudgeR', 0.1]]) {
  $(btn).addEventListener('click', () => {
    const cap = state.captions[state.selectedCaption];
    if (!cap) return;
    cap.start += delta;
    cap.end += delta;
    if (cap.words) cap.words = cap.words.map((w) => ({
      ...w, start: w.start + delta, end: w.end + delta,
    }));
    syncLineInspector();
    renderCapLane();
    if (!state.playing) drawFrame(state.cursor);
  });
}

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn && !btn.disabled) showPane(btn.dataset.pane);
});

$('capFont').addEventListener('change', applyFonts);
$('capAccentFont').addEventListener('change', applyFonts);
// A per-line face has to be fetched too before the canvas can draw with it.
$('lnFont').addEventListener('change', applyFonts);
$('lnAccentFont').addEventListener('change', applyFonts);
$('capReveal').addEventListener('input', () => {
  $('capPatternField').hidden = $('capReveal').value !== 'stack';
  if (!state.playing) drawFrame(state.cursor);
});

$('capOutlineOn').addEventListener('input', () => {
  $('capOutlineField').hidden = !$('capOutlineOn').checked;
});

for (const id of ['capOn', 'capSize', 'capPos', 'capOutline', 'capColor',
                  'capOutlineOn', 'capAccentColor', 'capPattern', 'capAccent',
                  'capOutlineColor', 'capUpper', 'capPop', 'capBox']) {
  $(id).addEventListener('input', () => {
    syncLabels();
    if (!state.playing) drawFrame(state.cursor);
  });
}

$('aspect').addEventListener('change', setAspect);
$('volume').addEventListener('input', (e) => (master.gain.value = Number(e.target.value)));
$('clipAudio').addEventListener('change', (e) => (clipBus.gain.value = Number(e.target.value)));

wave.addEventListener('click', (e) => {
  if (!state.audio) return;
  const rect = wave.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * state.audio.buffer.duration;
  state.cursor = clamp(t, state.tStart, state.tEnd);
  lastSegment = null;
  if (state.playing) play(state.cursor);
  else {
    drawFrame(state.cursor);
    drawWave();
  }
});

window.addEventListener('keydown', (e) => {
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' ||
    e.target.tagName === 'TEXTAREA';
  if (typing) return;
  if (e.code === 'Space') {
    e.preventDefault();
    state.playing ? pause() : play();
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreen();
  }
});

// Drop zones, scoped to the two panels. `dragleave` fires when the pointer
// crosses into a child element too, so compare against the zone's own box
// instead of counting enter/leave pairs - counters drift out of sync and
// leave the highlight stuck on.
function makeDropZone(zone, picker, input, target) {
  picker.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    loadFiles(e.target.files, target);
    input.value = ''; // let the same file be picked again later
  });

  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  zone.addEventListener('dragover', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (e) => {
    const r = zone.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) zone.classList.remove('over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files, target);
  });
}

makeDropZone($('audioZone'), $('audioPick'), $('audioInput'), 'audio');
makeDropZone($('mediaZone'), $('mediaPick'), $('mediaInput'), 'media');

// Dropping a file outside a zone would otherwise navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

window.addEventListener('resize', () => {
  buildWaveLayer();
  drawWave();
});

// Handy from the devtools console when something looks off.
window.beatcut = {
  state, audioCtx, play, pause, rebuild, startExport, selectSlot, drawFrame,
  EFFECTS, TRANSITIONS,
};

const fontMenu = fontOptions();
for (const id of ['capFont', 'capAccentFont', 'lnFont', 'lnAccentFont']) {
  $(id).innerHTML = fontMenu;
}
$('capFont').value = 'anton';         // heavy display reads best as the main face
$('capAccentFont').value = 'yellowtail'; // script, for the occasional word
applyFonts();
syncLineInspector();

fillSelect($('effect'), EFFECTS);
fillSelect($('transition'), TRANSITIONS);
fillSelect($('inspEffect'), EFFECTS, 'Use global');
fillSelect($('inspTransition'), TRANSITIONS, 'Use global');
$('effect').value = 'punch';
$('transition').value = 'cut';

setAspect();
syncModeFields();
syncLabels();
updateUi();
drawWave();
renderTimeline();
