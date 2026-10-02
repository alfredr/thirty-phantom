# 30 Phantom Codys

A haunted parking deck game in three.js and TypeScript. By day, Cody steals cars and parks
them in the deck. After 7pm he's phantom Cody: get a car out without badging out and it
leaves a ghost truck in its spot. The score is phantom occupancy, the badge log minus the
cars actually there.

Play it at <https://thirty-phantom.com> or <https://alfredr.github.io/thirty-phantom/>.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck and production build into dist/
```

With [mise](https://mise.jdx.dev), `mise run dev` and `mise run build` do the same and pin
Node 24 (`mise tasks` lists the rest).

## Controls

`WASD` move and drive, `SHIFT` run or drift, `SPACE` jump, `F` get in or out and talk,
`G` pay, `I` inventory, `X` raise the dead (phantom Cody), hold `B` to burn GhASt (monster
truck), `Q`/`E` rotate the view, wheel to zoom, `C` cycle the camera (top-down, chase,
auto), `M` mute, `H` help. Phones get on-screen controls. Hold `T` to fast-forward time,
`N` to skip to the next phase.

The game saves itself in the browser: the day, cash, inventory and every phantom.

## URL flags

| Flag | Effect |
| --- | --- |
| `?fresh` | start a new game instead of the saved one |
| `?sound=0` | no sound (`?sound` logs each sound by name in the console) |
| `?q=low` / `?q=high` | render quality |
| `?cam=chase` / `iso` / `auto` | starting camera |
| `?curve=0` / `1` | world curvature in the top-down view |
| `?boxes` | box-built stand-ins instead of the GLB models |
| `?level=<url>` | load a level from a JSON file |
| `?fps`, `?nav`, `?touch`, `?manual` | frame rate, planned routes, touch controls, no animation loop (headless tests) |

Console: `__game.debug.night()`, `.parkCar(spotId)`, `.teleport(x, y, z)`, `.state()`.

## Layout

```text
src/
  main.ts       boot
  config.ts     all tuning
  game/         rules, clock, garage ledger, valets, Randy, tutorial, inventory, save
  world/        procedural city and deck, collision, route planning, props
  actors/       vehicles, Cody, people, traffic, models
  render/       renderer, post effects, cameras, materials, lighting
  audio/        sound (cue table, synthesis, engines from recorded cycles)
  ui/           HUD, phone, dialogue, touch controls
  fx/           particles, ghosts, effects
tools/          headless screenshots, engine recording prep, dev reload prompt
deploy/         server setup and deploy script for thirty-phantom.com
public/         models, sound, icons
```

Sound recordings are CC0; see `public/audio/CREDITS.md`.

## Deploy

Every push to `main` publishes to GitHub Pages (`.github/workflows/pages.yml`).
`mise run deploy` builds and uploads to thirty-phantom.com (a small server running Caddy;
config in `deploy/`). `mise run deploy:rollback` puts the previous release back.
