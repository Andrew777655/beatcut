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

## Using it

1. **Music** — pick an audio file (mp3, wav, m4a…). It decodes and finds the beat
   in well under a second; the detected BPM shows up under the picker.
2. **Clips** — add images and videos, or drag them anywhere onto the page. Drag the
   tiles to reorder, hit **Shuffle** to randomize, ✕ on a tile to remove it.
3. **Preview** — press ▶ (or spacebar). Click anywhere on the waveform to scrub.
   The pink vertical lines are the cut points.
4. **Export video** — renders and downloads an MP4 to your Downloads folder.

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

**Look** — 9:16 for TikTok/Reels/Shorts. Punch zoom on cut is the effect that
makes it feel edited; flash and shake are strong, so drop the **Intensity**
slider if you turn them on. Slow drift is a gentle Ken Burns push over each clip.

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
