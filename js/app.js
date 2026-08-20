import { analyze, buildGrid, pickOnsets } from './analysis.js';
import { drawCaptions, captionAt, distribute, snapToBeat, transcribe } from './captions.js';
import { PAIRINGS, pairingById, loadPairing, fontString } from './fonts.js';

/* ================================================================ state == */

const state = {
  clips: [],            // {id, kind:'image'|'video', el, url, w, h, duration, thumb}
  order: [],            // clip ids, the sequence used on the timeline
  audio: null,          // {buffer, name, peaks}
  analysis: null,       // result of analyze()
  // Times are absolute positions in the song, so trimming is just a window.
  tStart: 0,            // where the edit begins in the song
  tEnd: 0,              // where it ends
  segments: [],         // {start, end, clipId, ov}
  captions: [],         // {id, text, start, end} in timeline seconds
  overrides: {},        // slot index -> per-slot edits, see DEFAULT_OV
  selected: null,       // index of the slot open in the inspector
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
  state.cursor = 0;
  $('trimStart').max = Math.max(0.1, decoded.duration - 0.5).toFixed(2);
  $('trimStart').value = 0;

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

function cutTimes() {
  const a = state.analysis;
  if (!a) return [];
  const mode = $('mode').value;
  if (mode === 'onsets') return drumHits();

  const cuts = gridCuts(beatTimes(), Number($('beatsPerCut').value));
  if (mode !== 'hybrid') return cuts;
  return mergeCuts(cuts, drumHits(), Number($('minGap').value));
}

function rebuild() {
  const maxClips = Number($('maxClips').value);
  const songEnd = state.audio ? state.audio.buffer.duration : 0;
  const from = clamp(state.tStart, 0, Math.max(0, songEnd - 0.2));
  const maxLen = Number($('editLength').value); // 0 = to the end of the song
  const until = clamp(maxLen > 0 ? from + maxLen : songEnd, from + 0.2, songEnd);

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
    drawCaptions(sctx, state.captions, t, W, H, captionStyle());
  }

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
  const dur = clip.el.duration || 0;
  const into = Math.max(0, t - seg.start);
  const start = Math.min(ov.inPoint, Math.max(0, dur - 0.05));
  clip.el.currentTime = dur ? start + (into % Math.max(0.05, dur - start)) : 0;
  if (clip.gain) clip.gain.gain.value = ov.volume;
  if (state.playing) clip.el.play().catch(() => {});
  else clip.el.pause();
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
let waveLayer = null;

function buildWaveLayer() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = wave.clientWidth || 800;
  const H = 140;

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
  const H = 140;
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

async function startExport() {
  if (!state.segments.length) return;

  showExportOverlay();
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

function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';

  if (!state.segments.length) {
    tl.innerHTML = '<div class="tl-empty">Load a song and some clips to build the timeline.</div>';
    return;
  }

  state.segments.forEach((seg, i) => {
    const el = document.createElement('div');
    el.className = 'tl-slot';
    el.dataset.i = i;
    // Constant pixels-per-second, so a fast slot always looks shorter than a
    // slow one no matter how long the song is.
    el.style.width = `${Math.max(26, (seg.end - seg.start) * TL_PX_PER_SEC)}px`;
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
  markPlayingSlot();
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
}

/* =========================================================== inspector == */

function syncInspector() {
  const i = state.selected;
  const seg = i != null ? state.segments[i] : null;
  $('inspector').hidden = !seg;
  if (!seg) return;

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

function captionStyle() {
  const pairing = pairingById($('capFont').value);
  const swap = $('capSwap').checked;
  const mainSlot = swap ? 'accent' : 'main';
  const accentSlot = swap ? 'main' : 'accent';

  return {
    size: Number($('capSize').value),
    position: $('capPos').value,
    outline: $('capOutlineOn').checked ? Number($('capOutline').value) : 0,
    color: $('capColor').value,
    accentColor: $('capAccentColor').value,
    outlineColor: $('capOutlineColor').value,
    uppercase: $('capUpper').checked,
    pop: $('capPop').checked,
    box: $('capBox').checked,
    reveal: $('capReveal').value,
    pattern: $('capPattern').value,
    accentRate: Number($('capAccent').value) / 100,
    // Passed as functions so the renderer can size each word independently.
    mainFont: (px) => fontString(pairing, mainSlot, px),
    accentFont: (px) => fontString(pairing, accentSlot, px),
  };
}

async function applyPairing() {
  const pairing = pairingById($('capFont').value);
  const subs = ['main', 'accent']
    .map((s) => pairing[s])
    .filter((f) => f.substitute)
    .map((f) => `${f.name} → ${f.substitute}`);
  $('capFontNote').textContent = subs.length
    ? `Substituted (original is a paid licence): ${subs.join(', ')}`
    : 'Both faces are the real thing.';

  await loadPairing(pairing);
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
  renderCaptionList();
  if (!state.playing) drawFrame(state.cursor);
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
      if (!state.playing) drawFrame(state.cursor);
    });

    const del = document.createElement('button');
    del.className = 'linkish';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', () => {
      state.captions.splice(i, 1);
      renderCaptionList();
      if (!state.playing) drawFrame(state.cursor);
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
    renderCaptionList();
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
  syncLabels();
  rebuild();
});

$('trimReset').addEventListener('click', () => {
  state.tStart = 0;
  $('trimStart').value = 0;
  $('editLength').value = '0';
  state.cursor = 0;
  lastSegment = null;
  syncLabels();
  rebuild();
});

for (const id of ['beatsPerCut', 'mode', 'bpm', 'sense', 'offset', 'maxClips',
                  'editLength', 'drumBand', 'minGap']) {
  $(id).addEventListener('input', () => {
    if (id === 'mode') {
      const mode = $('mode').value;
      const usesDrums = mode === 'onsets' || mode === 'hybrid';
      $('senseField').hidden = !usesDrums;
      $('drumBandField').hidden = !usesDrums;
      $('minGapField').hidden = !usesDrums;
      $('bpmField').hidden = mode === 'onsets';
    }
    syncLabels();
    rebuild();
  });
}

for (const id of ['effect', 'transition', 'transLen', 'intensity']) {
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
  syncInspector();
  [...$('timeline').children].forEach((el) => el.classList && el.classList.remove('selected'));
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
  renderCaptionList();
  if (!state.playing) drawFrame(state.cursor);
});
$('capTranscribe').addEventListener('click', runTranscribe);

$('capTiming').addEventListener('input', () => {
  $('capWordsField').hidden = $('capTiming').value !== 'word';
});

$('capFont').addEventListener('change', applyPairing);
$('capReveal').addEventListener('input', () => {
  $('capPatternField').hidden = $('capReveal').value !== 'stack';
  if (!state.playing) drawFrame(state.cursor);
});

$('capOutlineOn').addEventListener('input', () => {
  $('capOutlineField').hidden = !$('capOutlineOn').checked;
});

for (const id of ['capOn', 'capSize', 'capPos', 'capOutline', 'capColor',
                  'capOutlineOn', 'capAccentColor', 'capSwap', 'capPattern', 'capAccent',
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
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    state.playing ? pause() : play();
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

$('capFont').innerHTML = PAIRINGS
  .map((p) => `<option value="${p.id}">${p.label}</option>`)
  .join('');
applyPairing();

fillSelect($('effect'), EFFECTS);
fillSelect($('transition'), TRANSITIONS);
fillSelect($('inspEffect'), EFFECTS, 'Use global');
fillSelect($('inspTransition'), TRANSITIONS, 'Use global');
$('effect').value = 'punch';
$('transition').value = 'cut';

setAspect();
syncLabels();
updateUi();
drawWave();
renderTimeline();
