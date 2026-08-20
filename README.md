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

**Caption style** covers size, lower/centre/upper third, colours, uppercase, a dark
backing box, and a pop-in on the beat. The default is the usual look: heavy white
text, thick black outline, lower third. **Outline around text** turns the stroke
off entirely for clean flat type; the weight slider appears only while it's on.

### Fonts

Six pairings, each a heavy **main** face plus a softer **accent** face:

| Pairing | Main | Accent |
| --- | --- | --- |
| Tempting + Switzer | Switzer | Tempting |
| Athelas + Vanguard | Vanguard | Athelas |
| Inter + Times New Roman | Inter | Times New Roman |
| Arial Bold + Epic Pro | Arial Bold | Epic Pro |
| Shadow Light + BALBOA | BALBOA | Shadow Light |
| Archivo + Stix | Archivo | STIX Two Text |

**Swap main / accent** flips which face is the heavy one, since which reads as
"main" is a matter of taste.

**A licensing note.** Switzer, Inter, Archivo, STIX Two Text, Arial and Times New
Roman load legitimately — free, Google-hosted, or already on your system.
Tempting, Vanguard, Athelas, Epic Pro, Shadow Light and BALBOA are commercial
retail fonts that can't be redistributed, so those slots use free faces picked to
sit in the same visual territory (Yellowtail, Anton, Lora, Great Vibes, Oswald,
Parisienne). The panel names every substitution rather than pretending.

If you own a licence for the real thing, drop the `.woff2` into a `fonts/` folder
and add a `local: { family, url, weight }` entry to that slot in
[`js/fonts.js`](js/fonts.js) — it is preferred over the substitute automatically
and the "substituted" note disappears.

### Word reveal

*Whole line at once* is the plain subtitle behaviour.

*One word at a time* shows only the word currently being sung, alone and large.

*Stacked build* is the TikTok look: words pile up one under another as they're
sung, in rows of **1 · 2 · 1 · 3**, **Pairs**, or **Random**. The layout for the
whole line is computed up front and words simply become visible as they arrive,
so nothing jumps around while it fills.

The last two need per-word timing to look right, which is what auto-transcribe's
*Per word* mode produces. Typed captions get word times spread evenly across the
line instead — still fine, just not locked to the vocal.

For the tightest possible sync set **Words per line** to **1**: each word becomes
its own caption, timed individually. Word timings survive editing the text — the
displayed words are matched back to the timed ones by their spelling rather than
their position, so correcting a mistake doesn't throw away the timing for the
rest of the line.

### Accent words

**Accent words** sets what share of the longer words get the accent face — it
skips short words and common ones like "the" and "and", so it lands on words with
some weight to them. The choice is stable, not re-rolled every frame.

To force a specific word, wrap it in asterisks in the caption box: `*this*`. The
asterisks are stripped before drawing. Accent words also keep their original
capitalisation when UPPERCASE is on, since a cursive face reads badly in caps,
and can take their own colour.

### Auto-transcribe

Optional, folded away under the captions box. It runs OpenAI's Whisper **in this
tab** via `transformers.js` — your audio is never uploaded — but the model itself
downloads once from a CDN (40 MB to 800 MB depending on the model) and is cached
by the browser afterwards. So this one feature needs a connection the first time.

**Only the trimmed window is transcribed.** If the edit runs 20 s–35 s of a
three-minute track, Whisper only ever sees those 15 seconds — a twelfth of the
work, and no time spent on audio the video will never show. Set **Edit length**
and **Start of the song part** *before* transcribing. Timestamps are shifted back
into song time afterwards, so the captions still line up with the timeline.

**Set your expectations low.** Whisper is trained on speech. Sung vocals sitting
in a full mix are a different problem, and results range from decent on a sparse
track with clear vocals to unusable on a dense one. It is there to save you typing
a first draft, not to produce a finished caption track. *Snap lines to the beat
grid* pulls whatever it returns onto the nearest beat, which fixes the timing even
when the words need work — and the timing is the part that normally takes longest.

**Timing** decides where the lines land.

*Per word* (the default) asks Whisper for a timestamp on every individual word
and builds lines from those, breaking wherever the singer pauses. Lines then
start exactly on the word being sung, which is what you want for lyrics — the
captions follow the voice, not the cuts.

*Per line* uses Whisper's own coarser segments. Fewer, longer lines; use it if
per-word timing comes out jittery.

**Words per line** (per-word mode only) sets how much text is on screen at once.
3–4 reads best on a phone.

**Snap lines to the beat grid** is off by default. Word timing is already tied to
the vocal, and snapping it to the beat drags each line off the word it belongs
to. Only turn it on if you want captions locked to the cuts instead of the voice.

### Getting better words out of it

**Strip the backing track first** is off by default. It is a large lever when it
works, but on a sparse mix it can leave too little signal and Whisper hallucinates
on near-silence — try it both ways. Lead vocals are almost always panned dead centre, so per
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

### If it comes back as `>> >> >>` or one phrase on repeat

That's Whisper's repetition-loop failure: the model could not find speech but kept
generating anyway.

It is handled **after** decoding, not during. The obvious in-decoder fixes — an
n-gram repeat block and a repetition penalty — do stop loops, but they also forbid
a phrase from repeating, and a repeating phrase is what a hook *is*. They cost
more in lyric quality than they save, so they are deliberately not used.

Instead the transcript is cleaned afterwards: `>>` speaker markers and bracketed
tags like `[Music]` are stripped, and a line arriving **back to back** with itself
is absorbed into the previous one. Only consecutive repeats collapse — a chorus
returning later in the song is left alone, because counting total occurrences
would delete the very line you most want on screen. The status line reports how
many junk lines were removed, and distinguishes a genuine loop from a track that
simply read as music.

### If only part of the track gets captioned

Whisper processes long audio in 30-second chunks, and leaves the closing
timestamp `null` on the last word of each chunk. Words carrying a half-open
timestamp used to be discarded, which quietly lost a word at every chunk
boundary — and any caption line whose end landed at or before its start never
rendered at all, so whole stretches simply never appeared. Missing ends are now
inferred from the following word, and lines are forced into a strictly ordered,
non-overlapping sequence before they are used.

If a track comes back empty or heavily filtered, the audio genuinely had no
intelligible vocal for the model. Worth trying in order: a bigger model, an
explicit Language, and toggling *Strip the backing track first* — isolation
usually helps, but on a sparse mix it can leave too little signal, and Whisper
hallucinates on near-silence rather than admitting it heard nothing.

**Processing** picks where it runs. *Compatible* (the default) is 8-bit weights on
the CPU. *Fast* is `fp16` on the GPU via WebGPU — much quicker, and necessary for
the large model, but fp16 on some GPUs is less faithful than plain 8-bit on the
CPU. If words come out worse after switching, switch back; speed is not worth a
wrong transcript.

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

**Beat source** — three ways of deciding where cuts land.

*Tempo grid* lays down a perfect constant-tempo grid. Right for anything
produced to a click, and it never drifts — but it also never reacts, so a
hi-hat roll or a snare fill passes by unnoticed.

*Tempo grid + drum hits* keeps every grid cut and **adds** cuts where the drums
actually hit. This is the one for drill and trap: the edit stays locked to the
bar, then bursts into fast cuts through a roll. Grid cuts are never dropped.

*Drum hits only* ignores the grid entirely and cuts purely on transients — for
live recordings, acoustic tracks and rubato playing.

**Cut on** — which drum you follow, since "where are the hits" has a different
answer per instrument:

| | Frequency band | What it follows |
| --- | --- | --- |
| Hi-hats & rolls | 5–10.5 kHz | The fast stuff — rolls, fills, triplets |
| Snares & claps | 200 Hz–2 kHz | The backbeat |
| Kick & 808 | 30–250 Hz | The main pulse |
| Whole kit | full range | Everything, weighted to the low end |

For UK drill, **Hi-hats & rolls** is the setting you want. On a test pattern with
1/32 hat rolls, the high band produced 74 cuts through the roll against 28 in the
steady section, while the kick band stayed flat at 28 → 30 — the pulse doesn't
move, the hats do.

**Fastest cut** — the closest two cuts may land, 0.04 s to 0.6 s. This is the
throttle on roll detection: a 1/32 roll at 140 BPM is one hit every 0.054 s, so
anything above ~0.1 s here will quietly flatten the roll back to the grid. Turn it
down for machine-gun cutting, up if the result is too frantic to watch.

**Sensitivity** — how strong a transient has to be to count as a hit.

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
| `js/fonts.js` | Font pairings, webfont loading, licensing notes |
| `js/app.js` | Timeline, preview renderer, effects, export |

`window.beatcut` is exposed in the devtools console (`state`, `audioCtx`, `play`,
`rebuild`, `startExport`) if you want to poke at it.
