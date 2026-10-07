# 30 Phantom Codys

A browser game about filling a haunted parking garage, built with Three.js and TypeScript.

Steal cars and park them during the day. At night, possess them as monster trucks and
escape without using the exit gate. Each escape leaves a phantom behind, so the garage
still counts a vehicle that has left. Leave 30 phantoms to win.

[Play the game](https://thirty-phantom.com) or use the
[GitHub Pages mirror](https://alfredr.github.io/thirty-phantom/).

## Development

Use Node.js 24. The repository also pins this version for [mise](https://mise.jdx.dev).

```bash
npm ci
npm run dev          # Start the development server at http://localhost:5173
npm run fmt          # Apply lint fixes and format source files
npm run check        # Check lint, formatting, types, and unit tests
npm run build        # Check types and build the game into dist/
npm run preview      # Serve the production build at http://localhost:4173
```

Run `mise tasks` to see the equivalent mise commands.

Code changes display a reload prompt so a file save does not interrupt the game. Press
`R` or click the prompt to reload. CSS changes apply immediately.

Installing dependencies also installs the Husky pre-commit hook. The hook and CI both run
`npm run check`.

### Code conventions

Oxfmt formats TypeScript and JavaScript at 120 columns, wraps doc comments, and sorts
imports. It does not format CSS. Oxlint requires braces around conditional and loop bodies,
plus blank lines around multiline blocks. A variable declaration may sit directly above
the block that uses it. Oxlint also rejects `instanceof` through
[`tools/lint/rules.mjs`](tools/lint/rules.mjs). Use discriminated unions or shape checks.
Necessary platform checks require an inline exception with an explanation.

Prefer `type` aliases for object shapes. Use `interface` when declaration merging is needed.

In application code, import across folders with `@/`, which resolves to `src/`. Use `./`
for files in the same folder. Parent-relative imports (`../`) are rejected. Local game
imports omit the `.ts` extension; Node tools, tests, and schemas use explicit extensions
and relative paths. Keep extensions on CSS imports and package subpaths that require them.

### Tests

```bash
npm test             # Run unit and regression tests in tests/*.test.mjs
npm run typecheck    # Check application types and tests/types/ compile-time assertions
```

Browser scenarios in `tests/live/` run against the game with rendering disabled. Start
the development server in another terminal, then run:

```bash
npm run scenarios
npm run scenarios -- http://localhost:5173/ tutorial
npm run scenarios -- tutorial/sunriseInterrupts/imprint
```

The runner accepts a suite, case, or parameterized case name. Each case gets a separate
browser page. It uses three workers by default; set `JOBS` to change the count. Set `CHROME`
to your Chromium executable if it is not installed at
`/Applications/Chromium.app/Contents/MacOS/Chromium`.

## Controls

| Key | Action |
| --- | --- |
| `WASD` / arrow keys | Move or drive |
| `Shift` | Run or drift |
| `Space` | Jump |
| `F` | Enter or exit a vehicle, talk, or interact |
| `G` | Hotwire a parked car, or pay or tip a valet |
| `I` | Open the inventory or advance its selection |
| Backtick | Toggle the phone |
| `X` | Summon skeletons as phantom Cody |
| Hold `B` | Burn GhASt to boost a monster truck |
| `Q` / `E` | Rotate the view |
| Mouse / wheel | Look around in chase view / zoom |
| `C` | Cycle top-down, chase, and auto cameras |
| `M` | Open the map |
| `K` / `H` | Mute sound / show help |
| `R` | Reset a stuck car when prompted |
| Hold `T` / `N` | Fast-forward time / advance to the next day or night |

At an elevator, press `F` to call the cab. Inside, `F` selects the next floor up and `G`
the next floor down. Auto camera uses top-down view on foot and chase view while driving.
Touch devices have on-screen controls and use chase view while driving.

## Saved progress

The game stores the day, cash, inventory, phantoms, quest progress, shop stock, and remaining
daily cash pickups in browser storage. A completed game stays completed after a reload.
The player's position and ordinary vehicles are reset when the world loads.
Vehicle keys belong to those individual cars and reset with them.

Use `?fresh` to start without restoring the saved game. Replaying the tutorial also starts
a new game; saving is suspended while the tutorial runs, then the new progress replaces
the previous save. Save format version 2 still accepts version 1 saves.

## URL flags

Add flags to the game URL and join them with `&`, for example `?fresh&cam=iso`.

| Flag | Effect |
| --- | --- |
| `?fresh` | Start without restoring saved progress |
| `?sound=0` / `?sound` | Disable audio / enable audio and log sound cues |
| `?q=low` / `?q=high` | Set render quality |
| `?cam=chase` / `?cam=iso` / `?cam=auto` | Set the starting camera |
| `?curve=0` / `?curve=1` | Disable / enable world curvature in top-down view |
| `?boxes` | Use procedural models instead of GLB assets |
| `?level=<url>` | Load a JSON level |
| `?fps` | Show the frame rate |
| `?nav` | Show planned routes |
| `?touch` | Force touch controls |
| `?manual` | Disable the animation loop for scripted frame stepping |
| `?render=0` | Disable rendering, including shader compilation |

The browser console exposes `__game.debug.night()`, `.parkCar(spotId)`,
`.teleport(x, y, z)`, and `.state()`. Parking spot IDs start at zero. With `?manual`,
call `__game.frame(1 / 60)` to advance one frame.

### Custom levels

Custom levels require `version: 1`, `boxes`, `playerSpawn`, and `deck`. Other collections
default to empty arrays, and `name` defaults to `custom`. See the
[v1 schema](src/world/schema/level-v1.ts) for the full format.

The loader rejects invalid fields, unknown properties, unsupported versions, and invalid
geometry. If loading or validation fails, it logs the error and uses the generated city.

TypeBox defines the schema and TypeScript types. The Vite plugin compiles an Ajv validator
when the development server starts or the game is built. The browser loads the generated
validator only when loading a custom level; TypeBox and Ajv remain build dependencies.
Level format versions are independent of the app version. A breaking format change needs
a new schema and a matching loader branch.

## Source layout

```text
src/
  main.ts       startup and asset loading
  config.ts     shared gameplay and rendering settings
  engine/       math, input, state machines, actions, claims, collision, route search
  game/         gameplay rules, quests, tutorial, parking records, inventory, saves
  world/        city generation, navigation grid, buildings, props
  actors/       characters, shared movement and collision helpers
    vehicles/   vehicle instances, breeds, capabilities, traffic, autopilot
    npcs/       NPC instances, breeds, behaviors, fire and throwing capabilities
    skeletons/  summoned packs, breeds, behavior, movement, and animation
    models/     geometry builders and rigs
  render/       cameras, materials, lighting, post-processing
  audio/        synthesis, recorded engine cycles, mixing
  ui/           HUD, dialogue, inventory, touch controls
  fx/           particles and visual effects
tests/          unit tests, compile-time assertions, and browser scenarios
tools/          validation build step, browser test runner, screenshots, audio processing
deploy/         Caddy configuration and deployment scripts
public/         models, audio, icons
```

Actor families keep their breed definitions beside their runtime code. Breeds select
shared models, settings, and capabilities; each instance owns its changing state.
`engine/sim/` supplies the shared action runners, state machines, and claims.
Bob Nystrom's [Hauberk](https://github.com/munificent/hauberk) is the reference for this
composition of breeds, capabilities, and actions.

Hunting accepts a target source and an attack definition. The source chooses eligible
entities and supplies their current positions; each hunter owns its selected target and
cooldown. The game supplies damage and effect callbacks.

Inventory, consumption, shop stock, and exchanges live in `game/items/`. Each merchant
owns its stock. `game/randy/` contains Randy's dialogue; his breed selects the reusable
NPC behaviors used by his conversations and tutorial scenes.

Each vehicle has a plate and one set of keys. `actors/vehicles/ignition.ts` tracks
transfers between the ignition, people's keyrings, and ground pickups. Hotwiring bypasses
the ignition without producing keys. Drivers and Cody use the same ownership rules;
valet handovers transfer the matching set automatically.

Recorded audio uses CC0 assets. See the [sound credits](public/audio/CREDITS.md).

## Deployment

Pushes to `main` run checks, build the game, and deploy to GitHub Pages through the
[Pages workflow](.github/workflows/pages.yml). The workflow can also be started manually.

`npm run deploy` or `mise run deploy` builds the current working tree and uploads it to
thirty-phantom.com over SSH. Each upload creates a release, then switches the server's
`current` symlink to it. The server uses Caddy; [setup-server.sh](deploy/setup-server.sh)
installs or updates its configuration.

Use `mise run deploy:releases` to list releases and `mise run deploy:rollback` to restore
the previous release.
