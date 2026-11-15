# Demucs ONNX model

The game looks for the optional stem-separation model at:

```
static/models/htdemucs.onnx
```

If the file is missing, uploads and the normal BPM chart still work; only the
**Demucs** button needs this model.

## Default BPM chart

Uploading a song builds a BPM-based chart immediately (typically well under a
second after decoding). Notes are placed on the detected beat grid with a
0.35 s minimum gap, so the chart is sparse and playable. Without stem
separation the lanes are generic rhythm lanes and are labelled `LANE 1`–`LANE 4`.

## Manual editor

The **Manual map** button starts a recording pass over the loaded song. The
audio plays and keys **1–4** add a note to channels 1–4 at the current song
timestamp. Hits play the normal per-channel sound and flash effect but do not
affect the score.

The editor bar appears at the bottom-left with:

- **Replay** — restarts the song from the beginning and keeps all notes already
  recorded, so recording can continue.
- **Save .dmap** — downloads a self-contained `.dmap` with the notes and the
  original audio embedded.
- **Exit** — applies the recorded notes as a playable manual chart.

Manual maps use `LANE 1`–`LANE 4` labels. A saved manual `.dmap` contains the
audio, so it loads by itself like any other bundled map.

## Demucs button

The **Demucs** button appears next to the load control once a song is loaded.
Clicking it opens a loading screen and runs the 6-stem HT-Demucs separation on
that song:

- It is optional and slow (roughly 13 minutes for a 7-minute song).
- The loading screen shows progress and an estimated time remaining; it can be
  hidden while the BPM chart is played.
- When it finishes, it produces a portable note map. The current BPM chart is
  left running; use the **Save map** button to download the `.dmap` file.
- Load that map with **Load song** to apply the instrument chart. Loading the
  audio again still builds the normal BPM chart.

The instrument chart uses per-instrument onset peaks with a 0.44–0.5 s minimum
spacing, which is much less dense than the old frequency-band chart.

## Note map files

After a successful Demucs run, use the **Save map** button to download a
self-contained `.dmap` file. It contains:

- song fingerprint (name, size, duration)
- interval
- lane sources
- events in the form `{ "time": 1.23, "channel": 0 }`
- the original audio, base64 encoded (`audio`, `audio_type`, `audio_name`)

Loading a `.dmap` by itself loads its embedded audio **and** applies the
instrument map, so no separate MP3 selection is needed. Because the audio is
embedded, the `.dmap` is roughly 4/3 the size of the original MP3.

Legacy `.dmap` / `.json` maps without embedded audio still work. For those,
select the audio and map together, or load the map first and then the matching
audio (matched by normalized filename or size + duration). If a map without
audio is loaded for a different song, the current song is unloaded and the game
shows `NOTE MAP READY` so the previous song cannot keep playing.

Instrument-map lanes use the `DRUMS` / `BASS` / `GUITAR` / `PIANO` labels; BPM
charts use `LANE 1`–`LANE 4`.

## Included model

The browser-compatible **6-stem** HT-Demucs export is used:

- `StemSplitio/htdemucs-6s-onnx` on Hugging Face
- preferred file: `htdemucs_6s_fp16weights.onnx` (~130 MB)
- direct URL:
  `https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx`
- rename/copy it to `static/models/htdemucs.onnx`

Stem order is `drums, bass, other, vocals, guitar, piano`.

The game maps:

- channel 0 (red) ← drums
- channel 1 (green) ← bass
- channel 2 (blue) ← electric guitar
- channel 3 (yellow) ← piano/keyboard

Each channel's notes come from onset peaks in its own stem. Note detection is
split at 250 Hz: bass uses the low band, guitar/piano/other/vocals use the high
band, and drums use the full signal. A stem also has to pass a presence check
before its channel is enabled. Low-frequency bleed in a piano stem, for
example, is rejected because it has almost no high-band energy.

When an instrument is absent, its lane stays empty and is labelled `PIANO—`
instead of borrowing another instrument. If you want cross-instrument
fallback, set `FALLBACK_MISSING_INSTRUMENTS = true` in `static/js/main.js`;
pitched lanes still never fall back to drums. Empty lanes are dimmed and ignore
input. Hit/miss feedback uses a different synthesised timbre for each
instrument (drum thump, sub bass, plucked guitar, piano partials).

## 4-stem fallback

A 4-stem model (`StemSplitio/htdemucs-onnx`, ~316 MB) also works. Stem order is
`drums, bass, other, vocals`, and:

- guitar maps to `other`
- piano has no dedicated stem; it stays empty unless
  `FALLBACK_MISSING_INSTRUMENTS` is enabled

The stem count is read from the output tensor shape, so either export can be
placed at the same path.

## Tensor contract

- waveform input: `mix`, shape `[1, 2, 343980]` (7.8 s stereo at 44.1 kHz)
- waveform output: shape `[1, N, 2, 343980]`, where `N` is the number of stems

`onnxruntime-web` 1.18 is loaded lazily from jsDelivr when the Demucs button is
used. Constant folding is disabled for session creation because ORT otherwise
tries to materialise a multi-gigabyte inverse-STFT constant.

## Demucs performance

Inference runs in 7.8 s chunks with 10% overlap. ORT Web runs the model in its
proxy worker, so the page stays responsive while a chunk is processing, and
uses up to six WASM threads on a typical 4-core/8-thread laptop. A 24-second
clip takes roughly 85 seconds including model load, so a 7-minute song is
roughly 13–15 minutes.

The 6-stem model needs roughly 1.1 GB of RAM while its session is alive. The
session is released after each chart is built, and each ORT input/output
tensor is disposed after every chunk, so a long song does not accumulate
memory. If the browser reports out-of-memory errors, close other memory-heavy
applications before using the Demucs button.
