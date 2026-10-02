# 30 Phantom Codys

A browser game about filling a haunted parking garage, built with Three.js and TypeScript.
Steal cars and park them by day. After 7 PM, possess them as monster trucks and escape
without using the exit gate. Each escape leaves a phantom truck behind: the garage still
counts a car that is no longer there. Leave 30 phantoms to win.

[Play](https://thirty-phantom.com) · [GitHub Pages mirror](https://alfredr.github.io/thirty-phantom/)

## Development

Use Node.js 24.

```bash
npm ci
npm run dev          # http://localhost:5173
npm test             # save and item-trigger regression checks
npm run build        # typecheck and build into dist/
npm run preview      # serve dist/ at http://localhost:4173
```

[mise](https://mise.jdx.dev) pins Node 24 and provides the same tasks (`mise tasks` lists
them). In development, code changes show a reload prompt; press `R` to apply them.
CSS updates apply immediately.

## Controls

| Key | Action |
| --- | --- |
| `WASD` / arrow keys | Move or drive |
| `Shift` | Run or drift |
| `Space` | Jump |
| `F` | Get in or out, talk, or interact |
| `G` | Pay or tip a valet |
| `I` | Open inventory |
| `X` | Summon skeletons as phantom Cody |
| Hold `B` | Burn GhASt for a monster truck boost |
| `Q` / `E` | Rotate the view |
| Mouse / wheel | Look around in chase view / zoom |
| `C` | Cycle top-down, chase, and auto cameras |
| `M` / `H` | Mute sound / show help |
| Hold `T` / `N` | Fast-forward time / skip to the next day or night |

At an elevator, `F` calls the cab. Inside, `F` selects a floor up and `G` a floor down.
Auto camera uses top-down on foot and chase while driving. Phones have touch controls
and always use chase view while driving.

The game saves the day, cash, inventory, and phantoms in browser storage. Starting with
`?fresh` or replaying the tutorial replaces that save. The player's position and ordinary
vehicles reset on reload.

## URL flags

Append flags to the game URL; combine them with `&`, for example `?fresh&cam=iso`.

| Flag | Effect |
| --- | --- |
| `?fresh` | Start a new game |
| `?sound=0` / `?sound` | Disable audio / log sound cues in the console |
| `?q=low` / `?q=high` | Set render quality |
| `?cam=chase` / `?cam=iso` / `?cam=auto` | Set the starting camera |
| `?curve=0` / `?curve=1` | Disable / enable world curvature in top-down view |
| `?boxes` | Use procedural models instead of GLB assets |
| `?level=<url>` | Load a JSON level; see `src/world/level-data.ts` for its format |
| `?fps` | Show frame rate |
| `?nav` | Show planned routes |
| `?touch` | Force touch controls |
| `?manual` | Disable the animation loop for scripted frame stepping |

The browser console exposes `__game.debug.night()`, `.parkCar(spotId)`,
`.teleport(x, y, z)`, and `.state()`. Spot IDs start at zero. With `?manual`,
advance the game with `__game.frame(1 / 60)`.

## Source layout

```text
src/
  main.ts       startup and asset loading
  config.ts     shared gameplay and rendering settings
  game/         rules, tutorial, garage ledger, inventory, saves
  world/        city generation, collision, pathfinding, buildings, props
  actors/       characters, vehicles, traffic, models
  render/       cameras, materials, lighting, post-processing
  audio/        synthesis, recorded engine cycles, mixing
  ui/           HUD, dialogue, inventory, touch controls
  fx/           particles and visual effects
tests/          game-state regression tests
tools/          screenshots, audio preparation, dev reload prompt
deploy/         Caddy configuration and deployment scripts
public/         models, audio, icons
```

The recorded audio is CC0; see [sound credits](public/audio/CREDITS.md).

## Deploy

Pushes to `main` build and deploy to GitHub Pages through
[the Pages workflow](.github/workflows/pages.yml).

`npm run deploy` or `mise run deploy` builds and uploads to thirty-phantom.com over SSH.
The server runs Caddy and must be configured with [setup-server.sh](deploy/setup-server.sh).
`mise run deploy:releases` lists releases; `mise run deploy:rollback` restores the previous one.
