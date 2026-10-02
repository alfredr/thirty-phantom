# Sound credits

Everything the game plays is synthesized (src/audio/synth.ts) except the recordings in this
folder. Each one is CC0 1.0 (public domain), from Freesound's preview of it: trimmed, made mono,
levelled and re-encoded as mp3. The engines are stretches of each recording (idle, and on-load rev
ramps) cut into tagged engine cycles by tools/engine-grains.py (the cycles in engine-*.json) and
played by the engine's revs and load (src/audio/grains.ts). Loaded only with `?sound`, after the
first key, click or tap.

| File | Cue | Original | Author | License |
| --- | --- | --- | --- | --- |
| scream-high.mp3 | `scream: scream-high` | [Scream high pitch](https://freesound.org/people/riippumattog/sounds/812163/) | riippumattog | CC0 1.0 |
| scream-mid.mp3 | `scream: scream-mid` | [short scream.wav](https://freesound.org/people/Reitanna/sounds/241573/) | Reitanna | CC0 1.0 |
| scream-low.mp3 | `scream: scream-low` | [Man frightened yelling.wav](https://freesound.org/people/EricSueiro/sounds/220818/) | EricSueiro | CC0 1.0 |
| engine-sedan.mp3 | `engine: engine-sedan` | [Import car revs on Chassis Dyno with Turbo.wav](https://freesound.org/people/editboy23/sounds/496171/) | editboy23 | CC0 1.0 |
| engine-pickup.mp3 | `engine: engine-pickup` | [Auto Interior: Start, Shift & Accelerate](https://freesound.org/people/producerdan/sounds/333320/) | producerdan | CC0 1.0 |
| engine-truck.mp3 | `engine: engine-truck` | [Audi V8 Acceleration Sound](https://freesound.org/people/FFKoenigsegg20012017/sounds/339703/) | FFKoenigsegg20012017 | CC0 1.0 |
| engine-bike.mp3 | `engine: engine-bike` | [KawasakiZX6RStart.wav](https://freesound.org/people/Sclolex/sounds/211668/) | Sclolex | CC0 1.0 |
