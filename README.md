# BeatCut

Drop in photos and video clips, drop in a song, and it cuts the clips on the beat
and exports an MP4. Everything runs in your browser on your machine — no accounts,
no uploads, no backend, no Python, no ffmpeg.

## Setup

You already have Node 24 installed, which is all this needs.

1. Double-click **`start.bat`**.
2. A console window opens and your browser goes to `http://127.0.0.1:5173`.
3. That's it. Leave the console window open while you work; close it when done.

If the browser doesn't open on its own, go to <http://127.0.0.1:5173> manually.

**Use Chrome or Edge.** They can record MP4 directly. Firefox falls back to `.webm`,
which some apps won't accept.

## Hosting it (Vercel, GitHub Pages, anywhere)

The app is 100% client-side, so any static host works and everything still runs
on the viewer's machine — files are never uploaded.

`vercel.json` pins the deploy to a plain static serve of the repo root. Without
it, Vercel finds no `package.json` and no framework, guesses at a build output
directory that doesn't exist, and every route 404s.

`server.js` is **not** used when hosted — it exists only so the local
double-click workflow isn't on `file://`. Any https origin already satisfies the
browser, so hosted deploys export video fine.

Vercel project settings should read: Framework Preset **Other**, Build Command
**empty**, Output Directory **empty**, Root Directory **`./`**.

## Using it

1. **Music** — pick an audio file (mp3, wav, m4a…). It decodes and finds the beat
   in well under a second; the detected BPM shows up under the picker.
   **A video works here too** — drop one on the music panel and its soundtrack is
   extracted and used as the song. It won't be added as a clip; the panel you drop
   on decides what the file is for. Drop the same video on the clips panel to use
   its picture instead, or on both to use it for both.
2. **Clips** — add images and videos with the button, or drop them on that panel.
   They keep the order you selected them in. Drag the tiles to reorder, hit
   **Shuffle** to randomize, ✕ on a tile to remove one. Anything the browser
   can't decode (HEVC `.mov` from an iPhone is the usual culprit) is reported
   under the picker rather than silently becoming a black frame.
3. **Preview** — press ▶ (or spacebar). Click anywhere on the waveform to scrub.
   The pink vertical lines are the cut points.
4. **Timeline** — the strip under the waveform is one block per cut, sized by how
   long it's on screen, so you can see the pacing. Click a block to open the
   inspector and edit that slot on its own. Drag a tile from the clips panel onto
   a block to swap what plays there. A dot in the corner marks an edited slot,
   and the block under the playhead is outlined while it plays.
5. **Captions** — type or paste one line per caption, pick how many beats each
   line holds, and hit **Place on beats**. Lines land exactly on the grid, so
   they snap in with the cuts instead of drifting.
6. **Export video** — renders and downloads an MP4 to your Downloads folder.

## Captions

Captions are drawn onto the same canvas as the clips, so what you see in the
preview is exactly what ends up in the file — no separate subtitle track to go
out of sync.

**Place on beats** spreads the lines in the box across the beat grid,
`Beats per line` each (4 beats = one bar is the usual choice). If the playhead
is parked somewhere, placement starts from the nearest beat to it, so you can
drop a chorus in partway through. Each line then shows up in the list below with
its timecode — click the time to jump there, edit the text inline, ✕ to remove.

**Caption style** covers size, lower/centre/upper third, outline weight, text and
outline colour, uppercase, a dark backing box, and a pop-in on the beat. The
default is the usual look: heavy white text, thick black outline, lower third.

### Auto-transcribe

Optional, folded away under the captions box. It runs OpenAI's Whisper **in this
tab** via `transformers.js` — your audio is never uploaded — but the model itself
downloads once from a CDN (40 MB to 800 MB depending on the model) and is cached
by the browser afterwards. So this one feature needs a connection the first time.

**Set your expectations low.** Whisper is trained on speech. Sung vocals sitting
in a full mix are a different problem, and results range from decent on a sparse
track with clear vocals to unusable on a dense one. It is there to save you typing
a first draft, not to produce a finished caption track. *Snap lines to the beat
grid* pulls whatever it returns onto the nearest beat, which fixes the timing even
when the words need work — and the timing is the part that normally takes longest.

### Getting better words out of it

**Strip the backing track first** (on by default) is the biggest single lever, and
it isn't a model at all. Lead vocals are almost always panned dead centre, so per
frequency bin the left and right channels carry near-identical energy, while
guitars, synths, pads and reverb are spread wider. Keeping only the bins where the
channels agree, and band-limiting to 180 Hz–7 kHz to drop kick, bass and cymbals,
removes a lot of what Whisper is fighting. On test tones a hard-panned instrument
is removed completely and a centred bass note drops by 92 %, while a centred
vocal-range tone passes through untouched. It costs about 3 seconds on a
3-minute song. It is not true source separation — a centred kick still gets
through — and on a mono file only the band-limiting applies.

**Use a multilingual model.** The `.en` models are trained solely on English
speech and are markedly more brittle on singing, quite apart from being useless on
a track that isn't in English. Base multilingual is the default for that reason.

**Go bigger if it's still wrong.** Small is a clear step up from Base; Large v3
turbo is better again. The cost is download size and runtime — Large is ~800 MB
and slow without WebGPU.

**Set the Language** instead of leaving it on auto-detect. Sung vocals confuse
language detection, and a wrong guess wrecks the whole transcript.

Precision is chosen automatically: `fp16` on WebGPU, 8-bit weights on CPU, since
full precision on CPU is unusably slow. The 8-bit path does cost some accuracy —
if your browser has WebGPU (Chrome and Edge do), you're already on the better one.

Instrumental tracks correctly come back with nothing.

Captions only ever show text you supply or that was transcribed from your own
audio file — there's no lyrics database wired in.

## Editing one slot

Selecting a timeline block opens the inspector at the top of the right panel:

**Show clip** — pin a specific clip to this slot, or leave it on *Auto* to follow
the normal rotation. Dragging a tile onto the block does the same thing.

**Clip volume** *(video only)* — rides a dedicated gain node for that clip, so it
works both in the preview and in the export. Remember the global **Clip audio**
setting has to be above zero for any of it to be audible.

**Start inside clip** *(video only)* — the in-point. Use it to skip a boring first
second, or to show a different moment of the same video in each slot it appears
in. If the slot outlasts the clip, playback loops back to this point, not to zero.

**Effect** and **Transition in** — override the global dropdowns for this slot
only. *Use global* follows the Look section. This is how you give one clip a
glitch while everything else punches, or put a whip pan on a single cut.

**Zoom, Brightness, Contrast, Saturation, Hue, Mirror** — per-slot look. These
composite at render time, so they land in the export exactly as previewed.

**Apply look to all** copies zoom, colour and mirror onto every slot, leaving each
slot's own clip, trim and volume alone — handy for grading a whole edit at once.
**Reset slot** clears just the selected one.

Slot edits are keyed by position, so changing BPM or the cut rate afterwards
reshuffles which clip lands where while the edits stay with the slot number.
Do your global timing first, then polish individual slots.

## The controls that matter

**Cut every** — 1 beat is the classic fast TikTok edit. 2 beats is calmer,
4 beats (one bar) is cinematic, ½ beat is frantic. This is the single biggest
lever on how the edit feels.

**Beat source** — *Tempo grid* assumes a steady tempo and lays down a perfect
grid. Right for basically all electronic, pop, hip-hop, and anything produced to
a click. *Onset detection* cuts on whatever transient it hears instead, which
suits live recordings, acoustic tracks, and rubato playing. The **Sensitivity**
slider then controls how many onsets qualify.

**BPM** — auto-detected. If the edit feels twice as fast or twice as slow as the
music, hit **÷2** or **×2**; picking the wrong octave is the most common beat
tracking error and this fixes it in one click. **Reset to detected** undoes any
manual change.

**Nudge beats** — shifts every cut earlier or later in milliseconds. If cuts feel
a hair late, drag it negative. Cutting slightly *before* the beat usually reads
better than slightly after.

**Edit length** — how long the finished video is: 7, 10, 15, 20, 30, 45, 60 seconds,
or the rest of the song. 15 s or under is the safe range for a hook-driven edit.

**Start of the song part** — where in the track the edit begins. Drag the slider,
or scrub the waveform to the moment you want and hit **Start here (playhead)**.
Together with Edit length this picks any window of the song — the chorus rather
than the intro, say. The waveform dims everything outside that window so you can
see what's actually being used, and the exported file contains only that window.
**Whole song** resets both.

**Stop after** — cap the edit at 8/16/24/32 clips. Whichever runs out first,
this or the edit length, ends the video.

**Look** — 9:16 for TikTok/Reels/Shorts.

*Effect on each clip* (14 options) is what happens **during** a slot: punch zoom,
punch + flash, flash, shake, bounce, slow drift in/out, pan left/right, pulse,
tilt, blur in, glitch. Punch zoom is the one that makes an edit feel edited;
flash, shake and glitch are strong, so pull **Intensity** down when using them.

*Transition between clips* (11 options) is what happens **at** a cut: hard cut,
crossfade, dip to black, dip to white, slide left/right/up, whip pan, zoom blur,
wipe, glitch cut. Hard cut is the classic beat-sync look — transitions soften the
hit, so keep **Transition length** short (120–200 ms) if you still want the cut
to land on the beat. It's capped at 90% of a slot's length so a fast edit can
never turn into a permanent dissolve.

*Randomise per-clip effects* assigns a different effect to every slot at once —
the fastest way to get a chaotic edit, then fix up the slots you don't like.

Every effect and transition can be overridden per slot in the inspector, where
*Use global* means "follow the dropdowns above".

**Clip audio** — video clips are muted by default so you only hear the song. Set
it to "quiet under music" if you want the original audio bleeding through.

## Things worth knowing

- **Export runs in real time.** A 30-second edit takes 30 seconds to record.
  Keep the tab visible and don't minimize the window while it renders — the
  browser throttles background tabs and you'd get dropped frames.
- Clips loop through your list in order. Fewer clips than cuts means they repeat;
  more clips than cuts means the extras go unused (raise "Stop after", or use
  a longer song).
- Video clips that are shorter than their slot loop; longer ones get trimmed.
- Nothing leaves your computer. The included `server.js` only serves the three
  local files — it exists because browsers refuse to let a `file://` page export
  video from a canvas.

## How the beat detection works

`js/analysis.js`, no libraries:

1. Downmix to mono at 22.05 kHz.
2. Short-time Fourier transform (1024-point, 256 hop → ~86 frames/sec).
3. Half-wave rectified **spectral flux** onset envelope, averaged within 24
   log-spaced bands. Band-averaging matters: summing raw bins lets a broadband
   hi-hat outweigh a kick that occupies three bins, and hi-hats sit on the
   offbeat — that's how beat trackers end up locked half a beat off.
4. Tempo from the **autocorrelation** of that envelope, weighted by a log-normal
   prior around 120 BPM.
5. Octave check across bpm/2, bpm, bpm×2, each refined to sub-frame precision.
6. Beat **phase** locked using a bass-only (30–250 Hz) envelope, so cuts land on
   the kick rather than the hat.

Measured against synthetic click tracks at 75–174 BPM: tempo within 0.2%,
cuts within about 10 ms of the true beat.

## Files

| File | What it is |
| --- | --- |
| `start.bat` | Double-click launcher |
| `server.js` | 30-line static file server (Node built-ins only) |
| `index.html` | The app |
| `styles.css` | Styling |
| `js/analysis.js` | FFT, onset detection, tempo and beat tracking |
| `js/captions.js` | Caption rendering, beat snapping, Whisper transcription |
| `js/app.js` | Timeline, preview renderer, effects, export |

`window.beatcut` is exposed in the devtools console (`state`, `audioCtx`, `play`,
`rebuild`, `startExport`) if you want to poke at it.
