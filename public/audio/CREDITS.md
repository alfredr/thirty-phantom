# Sound credits

These recordings come from Freesound previews released under CC0 1.0. They were trimmed,
converted to mono, normalized, and encoded as MP3. Other sounds are synthesized in
[`src/audio/synth.ts`](../../src/audio/synth.ts).

[`tools/engine-grains.py`](../../tools/engine-grains.py) extracts engine cycles from idle and
acceleration recordings. The `engine-*.json` files store cycle timing, rate, load, and level;
[`src/audio/grains.ts`](../../src/audio/grains.ts) uses them to match playback to the vehicle.

Audio is on by default. Recordings load after the first key press, click, or tap.
Use `?sound=0` to disable audio or `?sound` to log sound cues in the console.

| File | Cue | Original | Author | License |
| --- | --- | --- | --- | --- |
| scream-high.mp3 | `scream: scream-high` | [Scream high pitch](https://freesound.org/people/riippumattog/sounds/812163/) | riippumattog | CC0 1.0 |
| scream-mid.mp3 | `scream: scream-mid` | [short scream.wav](https://freesound.org/people/Reitanna/sounds/241573/) | Reitanna | CC0 1.0 |
| scream-low.mp3 | `scream: scream-low` | [Man frightened yelling.wav](https://freesound.org/people/EricSueiro/sounds/220818/) | EricSueiro | CC0 1.0 |
| engine-sedan.mp3 | `engine: engine-sedan` | [Import car revs on Chassis Dyno with Turbo.wav](https://freesound.org/people/editboy23/sounds/496171/) | editboy23 | CC0 1.0 |
| engine-pickup.mp3 | `engine: engine-pickup` | [Auto Interior: Start, Shift & Accelerate](https://freesound.org/people/producerdan/sounds/333320/) | producerdan | CC0 1.0 |
| engine-truck.mp3 | `engine: engine-truck` | [Audi V8 Acceleration Sound](https://freesound.org/people/FFKoenigsegg20012017/sounds/339703/) | FFKoenigsegg20012017 | CC0 1.0 |
| engine-bike.mp3 | `engine: engine-bike` | [KawasakiZX6RStart.wav](https://freesound.org/people/Sclolex/sounds/211668/) | Sclolex | CC0 1.0 |
