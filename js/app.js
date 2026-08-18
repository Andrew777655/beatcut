import { analyze, buildGrid, pickOnsets } from './analysis.js';

/* ================================================================ state == */

const state = {
  clips: [],            // {id, kind:'image'|'video', el, url, w, h, duration, thumb}
  order: [],            // clip ids, the sequence used on the timeline
  audio: null,          // {buffer, name, peaks}
  analysis: null,       // result of analyze()
  segments: [],         // {start, end, clipId}
  duration: 0,          // timeline length in seconds
  playing: false,
  startedAt: 0,         // audioCtx time at t = 0
  playOffset: 0,        // where playback started within the timeline
  cursor: 0,
  exporting: false,
};

let nextId = 1;

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

function loadFiles(files) {
  const jobs = [];
  for (const file of files) {
    if (file.type.startsWith('audio/')) jobs.push(loadAudio(file));
    else if (file.type.startsWith('image/')) jobs.push(loadImage(file));
    else if (file.type.startsWith('video/')) jobs.push(loadVideo(file));
  }
  return Promise.all(jobs).then(() => {
    renderClipList();
    rebuild();
  });
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const el = new Image();
  el.src = url;
  await el.decode().catch(() => {});
  const clip = {
    id: nextId++,
    kind: 'image',
    el,
    url,
    w: el.naturalWidth || 1,
    h: el.naturalHeight || 1,
    duration: Infinity,
    thumb: url,
    name: file.name,
  };
  state.clips.push(clip);
  state.order.push(clip.id);
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
  });

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
    w: el.videoWidth || 1,
    h: el.videoHeight || 1,
    duration: el.duration || 0,
    thumb,
    name: file.name,
    audioNode: null,
  };

  // Route the clip's own audio through the mix so it can be exported too.
  try {
    clip.audioNode = audioCtx.createMediaElementSource(el);
    clip.audioNode.connect(clipBus);
    el.muted = false;
    el.volume = 1;
  } catch { /* some codecs refuse; stays silent */ }

  state.clips.push(clip);
  state.order.push(clip.id);
}

async function loadAudio(file) {
  $('audioLabel').textContent = file.name;
  $('analyzeState').textContent = 'Decoding…';
  const buf = await file.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(buf);

  $('analyzeState').textContent = 'Finding beats…';
  await new Promise((r) => setTimeout(r, 20)); // let the label paint

  const t0 = performance.now();
  const result = analyze(decoded);
  const ms = Math.round(performance.now() - t0);

  state.audio = { buffer: decoded, name: file.name, peaks: computePeaks(decoded, 2000) };
  state.analysis = result;

  $('bpm').value = result.bpm.toFixed(2);
  $('analyzeState').textContent =
    `${result.beats.length} beats · ${result.bpm.toFixed(1)} BPM · analysed in ${ms} ms`;
  syncLabels();
}

/* ================================================= timeline generation == */

function beatTimes() {
  const a = state.analysis;
  if (!a) return [];
  const nudge = Number($('offset').value) / 1000;

  if ($('mode').value === 'onsets') {
    const sense = Number($('sense').value);
    return pickOnsets(a, sense).map((t) => t + nudge).filter((t) => t > 0);
  }
  const bpm = Number($('bpm').value);
  return buildGrid(bpm, a.offset + nudge, a.duration).filter((t) => t > 0);
}

function rebuild() {
  const beats = beatTimes();
  const per = Number($('beatsPerCut').value);
  const maxClips = Number($('maxClips').value);
  const songEnd = state.audio ? state.audio.buffer.duration : 0;

  // Cut points: every `per` beats. Half-beat mode interpolates midpoints.
  let cuts = [];
  if (per < 1) {
    for (let i = 0; i < beats.length - 1; i++) {
      cuts.push(beats[i], (beats[i] + beats[i + 1]) / 2);
    }
    if (beats.length) cuts.push(beats[beats.length - 1]);
  } else {
    for (let i = 0; i < beats.length; i += per) cuts.push(beats[i]);
  }
  cuts = cuts.filter((t) => t > 0.06 && t < songEnd - 0.06);

  const order = state.order.filter((id) => state.clips.some((c) => c.id === id));
  state.segments = [];

  if (!order.length || !state.audio) {
    state.duration = songEnd;
    drawWave();
    updateUi();
    return;
  }

  const bounds = [0, ...cuts, songEnd];
  const count = maxClips > 0 ? Math.min(maxClips, bounds.length - 1) : bounds.length - 1;
  for (let i = 0; i < count; i++) {
    state.segments.push({
      start: bounds[i],
      end: bounds[i + 1],
      clipId: order[i % order.length],
    });
  }

  state.duration = state.segments.length
    ? state.segments[state.segments.length - 1].end
    : songEnd;

  drawWave();
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
  return segs.length && t >= state.duration ? segs[segs.length - 1] : segs[0] || null;
}

/* ================================================================ draw == */

function drawCover(ctx, src, sw, sh, W, H, scale, dx, dy) {
  if (!sw || !sh) return;
  const s = Math.max(W / sw, H / sh) * scale;
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h);
}

let lastSegment = null;

function drawFrame(t) {
  const W = stage.width;
  const H = stage.height;
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

  const dt = Math.max(0, t - seg.start);
  const segLen = Math.max(0.001, seg.end - seg.start);
  const k = Number($('intensity').value) / 100;

  let scale = 1;
  let dx = 0;
  let dy = 0;

  if ($('fxDrift').checked) scale *= 1 + 0.06 * k * (dt / segLen);
  if ($('fxPunch').checked) scale *= 1 + 0.14 * k * Math.exp(-dt / 0.11);
  if ($('fxShake').checked) {
    const amp = 26 * k * Math.exp(-dt / 0.09);
    dx += Math.sin(dt * 90) * amp;
    dy += Math.cos(dt * 71) * amp;
  }

  const src = clip.kind === 'video' ? clip.el : clip.el;
  const sw = clip.kind === 'video' ? clip.el.videoWidth || clip.w : clip.w;
  const sh = clip.kind === 'video' ? clip.el.videoHeight || clip.h : clip.h;

  try {
    drawCover(sctx, src, sw, sh, W, H, scale, dx, dy);
  } catch { /* frame not decodable yet */ }

  if ($('fxFlash').checked) {
    const a = 0.5 * k * Math.exp(-dt / 0.07);
    if (a > 0.003) {
      sctx.fillStyle = `rgba(255,255,255,${Math.min(a, 0.9)})`;
      sctx.fillRect(0, 0, W, H);
    }
  }

  // Keep short videos looping inside a long segment.
  if (clip.kind === 'video' && state.playing && clip.el.duration) {
    if (clip.el.currentTime >= clip.el.duration - 0.06) {
      clip.el.currentTime = 0;
      clip.el.play().catch(() => {});
    }
  }
}

function onSegmentEnter(seg, clip, t) {
  for (const c of state.clips) {
    if (c.kind === 'video' && c !== clip) c.el.pause();
  }
  if (clip.kind === 'video') {
    const into = Math.max(0, t - seg.start);
    const dur = clip.el.duration || 0;
    clip.el.currentTime = dur ? into % dur : 0;
    if (state.playing) clip.el.play().catch(() => {});
    else clip.el.pause();
  }
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

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = wave.clientWidth || 800;
  wave.width = cssW * dpr;
  wave.height = 140 * dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = 140;
  wctx.clearRect(0, 0, W, H);
  if (!state.audio) return;

  const peaks = state.audio.peaks;
  const dur = state.audio.buffer.duration;

  wctx.fillStyle = '#39414f';
  for (let x = 0; x < W; x++) {
    const p = peaks[Math.floor((x / W) * peaks.length)] || 0;
    const h = Math.max(1, p * H * 0.85);
    wctx.fillRect(x, (H - h) / 2, 1, h);
  }

  // Cut markers.
  wctx.strokeStyle = 'rgba(255,45,120,0.85)';
  wctx.lineWidth = 1;
  wctx.beginPath();
  for (const seg of state.segments) {
    const x = (seg.start / dur) * W;
    wctx.moveTo(x + 0.5, 0);
    wctx.lineTo(x + 0.5, H);
  }
  wctx.stroke();

  // Playhead.
  const px = (state.cursor / dur) * W;
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
  if (from >= state.duration - 0.05) from = 0;

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
    if (t >= state.duration) {
      state.cursor = 0;
      pause();
      if (state.exporting) finishExport();
      drawFrame(0);
      drawWave();
      return;
    }
    state.cursor = t;
    drawFrame(t);
    drawWave();
    $('time').textContent = `${fmt(t)} / ${fmt(state.duration)}`;
    if (state.exporting) setExportProgress(t / state.duration);
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

async function startExport() {
  if (!state.segments.length) return;
  exportMime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  if (!exportMime) {
    alert('This browser cannot record video. Use Chrome or Edge.');
    return;
  }

  pause();
  await ensureAudio();
  state.cursor = 0;
  drawFrame(0);

  const fps = 30;
  const videoStream = stage.captureStream(fps);
  const mixed = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...streamDest.stream.getAudioTracks(),
  ]);

  chunks = [];
  recorder = new MediaRecorder(mixed, {
    mimeType: exportMime,
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 192_000,
  });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = saveRecording;

  state.exporting = true;
  $('exportOverlay').hidden = false;
  setExportProgress(0);
  recorder.start(500);
  play(0);
}

function finishExport() {
  if (!state.exporting) return;
  state.exporting = false;
  setTimeout(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, 350); // let the tail of the audio flush into the muxer
}

function cancelExport() {
  state.exporting = false;
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
  $('time').textContent = `${fmt(state.cursor)} / ${fmt(state.duration)}`;

  const a = state.analysis;
  $('readout').textContent = a
    ? `${state.clips.length} clips · ${Number($('bpm').value).toFixed(2)} BPM · ` +
      `${state.segments.length} cuts · ${fmt(state.duration)}`
    : 'Load a song to start';
}

function syncLabels() {
  $('senseVal').textContent = Number($('sense').value).toFixed(2);
  $('offsetVal').textContent = `${$('offset').value} ms`;
  $('intensityVal').textContent = `${$('intensity').value}%`;
}

function setAspect() {
  const [w, h] = $('aspect').value.split('x').map(Number);
  stage.width = w;
  stage.height = h;
  drawFrame(state.cursor);
}

const fmt = (s) => {
  s = Math.max(0, s || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ============================================================== events == */

$('audioInput').addEventListener('change', (e) => loadFiles(e.target.files));
$('mediaInput').addEventListener('change', (e) => loadFiles(e.target.files));

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

for (const id of ['beatsPerCut', 'mode', 'bpm', 'sense', 'offset', 'maxClips']) {
  $(id).addEventListener('input', () => {
    if (id === 'mode') {
      const onsets = $('mode').value === 'onsets';
      $('senseField').hidden = !onsets;
      $('bpmField').hidden = onsets;
    }
    syncLabels();
    rebuild();
  });
}

for (const id of ['fxPunch', 'fxFlash', 'fxShake', 'fxDrift', 'intensity']) {
  $(id).addEventListener('input', () => {
    syncLabels();
    if (!state.playing) drawFrame(state.cursor);
  });
}

const setBpm = (v) => {
  $('bpm').value = clamp(v, 40, 300).toFixed(2);
  rebuild();
};
$('bpmHalf').addEventListener('click', () => setBpm(Number($('bpm').value) / 2));
$('bpmDouble').addEventListener('click', () => setBpm(Number($('bpm').value) * 2));
$('bpmReset').addEventListener('click', () => {
  if (state.analysis) setBpm(state.analysis.bpm);
});

$('aspect').addEventListener('change', setAspect);
$('volume').addEventListener('input', (e) => (master.gain.value = Number(e.target.value)));
$('clipAudio').addEventListener('change', (e) => (clipBus.gain.value = Number(e.target.value)));

wave.addEventListener('click', (e) => {
  if (!state.audio) return;
  const rect = wave.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * state.audio.buffer.duration;
  state.cursor = clamp(t, 0, state.duration);
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

// Drag and drop anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  $('dropHint').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').hidden = true;
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

window.addEventListener('resize', drawWave);

// Handy from the devtools console when something looks off.
window.beatcut = { state, audioCtx, play, pause, rebuild, startExport };

setAspect();
syncLabels();
updateUi();
drawWave();
