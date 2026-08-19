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
5. **Export video** — renders and downloads an MP4 to your Downloads folder.

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

**Stop after** — cap the edit at 8/16/24/32 clips instead of running the whole song.

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
| `js/app.js` | Timeline, preview renderer, effects, export |

`window.beatcut` is exposed in the devtools console (`state`, `audioCtx`, `play`,
`rebuild`, `startExport`) if you want to poke at it.
