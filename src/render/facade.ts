import {
  type CanvasTexture,
  type MeshStandardMaterial,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { FACADE, FACE_CODE } from '@/world/facade-layout';

import { FACE_DATA } from './geometry';
import { makeCanvas, toTexture } from './textures';

/**
 * Facade shader tuning (meters unless noted). Windows are laid out per bay and
 * storey from each face's FACE_DATA (world/facade-layout.ts), and the rooms
 * behind them are ray-cast in the fragment shader ("interior mapping", Joost
 * van Dongen 2008): a back wall, side walls, floor and ceiling, a furniture
 * silhouette card part way in, and blinds or curtains on some windows.
 */
const LOOK = {
  /** Minimum window-frame thickness in meters and pixels. */
  frame: 0.07,
  framePx: 1.3,
  /**
   * Sill extension beyond punched or paired windows and sill height, in
   * meters.
   */
  sillRun: 0.1,
  sillHeight: 0.14,
  /**
   * Emission multiplier for physical room surfaces, scaled by the windows
   * channel.
   */
  roomGlow: 0.35,
  /** Height of the dark plinth on plain ground floors, in meters. */
  plinth: 0.6,
  /**
   * Room depth in meters for upper floors, shops, and lobbies, followed by the
   * range of furniture-card positions as a fraction of room depth.
   */
  depth: [FACADE.room, 6, 8],
  card: [0.35, 0.65],
  /**
   * Base and additional per-floor probabilities of lit rooms, followed by the
   * probability of an entirely dark floor.
   */
  lit: 0.3,
  litSpread: 0.3,
  darkFloor: 0.2,
  /** Probability that a shop or lobby is lit at night. */
  litShop: 0.85,
  /**
   * Room emission strength, lamp attenuation coefficient in inverse square
   * meters, and minimum attenuation factor.
   */
  glow: 0.6,
  falloff: 0.18,
  glowFloor: 0.2,
  /**
   * Daylight room brightness multiplier and sky-reflection weights at the
   * bottom and top of a window.
   */
  dayRoom: 0.32,
  reflect: [0.3, 0.55],
  /** Number of facade bays sharing one shop or lobby interior. */
  wideRoom: 3,
  /**
   * Probabilities of blinds and curtains, followed by the range of blind
   * coverage as a fraction of window height.
   */
  blinds: 0.22,
  curtains: 0.18,
  blindDrop: [0.25, 0.85],
  /**
   * Meters-per-pixel range over which interior ray casting fades to an average
   * color.
   */
  farPx: [0.14, 0.3],
  /** Awnings: stripe width. */
  stripe: 0.45,
} as const;

const f = (n: number): string => n.toFixed(4);
const F = FACADE.front;
/** Upper storeys' windows, shared with walk-in buildings' real openings. */
const G = FACADE.glazing;

/** How many walk-in buildings can have their rooms built at once. */
export const LIVE_MAX = 2;

/**
 * Active interior footprints (x0, z0, x1, z1) and their highest rendered floor
 * tops, set by world/interiors.ts. Discard facade glass and door fragments
 * within these bounds to reveal physical interiors and their window panes.
 * Unused slots contain empty rectangles.
 */
export const facadeUniforms = {
  uLiveRect: {
    value: Array.from({ length: LIVE_MAX }, () => new Vector4(0, 0, -1, -1)),
  },
  uLiveTop: { value: new Array<number>(LIVE_MAX).fill(-1) },
};

const VERT_HEAD = /* glsl */ `
attribute vec4 ${FACE_DATA};
varying vec4 vFaceData;
varying vec2 vFaceUv;
varying vec3 vFaceN;
`;

const FRAG_HEAD = /* glsl */ `
varying vec4 vFaceData;
varying vec2 vFaceUv;
varying vec3 vFaceN;
uniform sampler2D uFurniture;
uniform vec4 uLiveRect[${LIVE_MAX}];
uniform float uLiveTop[${LIVE_MAX}];
vec3 facEmit = vec3(0.0);
float facGlass = 0.0;

// Dave Hoskins' hash without sine (stable on mobile GPUs)
float fHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Test the built interior footprint and upper height limit; fLive unrolls this check for each slot.
bool fLiveIn(vec3 p, vec4 r, float top) {
  return p.x > r.x - 0.05 && p.x < r.z + 0.05 && p.z > r.y - 0.05 && p.z < r.w + 0.05 && p.y < top;
}
bool fLive(vec3 p) {
  return ${Array.from({ length: LIVE_MAX }, (_, i) => `fLiveIn(p, uLiveRect[${i}], uLiveTop[${i}])`).join(' || ')};
}
// Return a rectangle mask with antialiasing width w around the lo and hi edges.
float fBox(vec2 p, vec2 lo, vec2 hi, vec2 w) {
  vec2 a = smoothstep(lo - w, lo + w, p) - smoothstep(hi - w, hi + w, p);
  return clamp(a.x, 0.0, 1.0) * clamp(a.y, 0.0, 1.0);
}
// Select wall, floor and lamp colors from stable room hashes.
vec3 fPaint(float h) {
  return h < 0.17 ? vec3(0.8, 0.66, 0.48) : h < 0.34 ? vec3(0.82, 0.46, 0.58) : h < 0.5 ? vec3(0.42, 0.74, 0.58)
    : h < 0.67 ? vec3(0.6, 0.48, 0.86) : h < 0.84 ? vec3(0.3, 0.58, 0.68) : vec3(0.82, 0.6, 0.28);
}
vec3 fFloor(float h) {
  return h < 0.4 ? vec3(0.4, 0.24, 0.16) : h < 0.7 ? vec3(0.3, 0.24, 0.4) : vec3(0.5, 0.44, 0.42);
}
vec3 fLamp(float h) {
  return h < 0.45 ? vec3(1.0, 0.72, 0.38) : h < 0.7 ? vec3(1.0, 0.86, 0.62) : h < 0.85 ? vec3(0.7, 0.9, 1.0)
    : h < 0.96 ? vec3(0.66, 0.42, 1.0) : vec3(0.5, 1.0, 0.2);
}

/*
 * Render a virtual room behind the window using ray-box intersection. Express o
 * and r in room coordinates: X from the left wall, Y above the floor and Z into
 * the building. Positions and size use meters. kind selects a room (0), shop (1)
 * or lobby (2). Return daylight albedo and write nighttime emission to glow,
 * with furniture and lighting selected by seed.
 */
vec3 fRoom(vec3 o, vec3 r, vec3 size, float seed, float kind, bool lit, vec3 lamp, out vec3 glow) {
  vec3 inv = 1.0 / max(abs(r), vec3(1e-4));
  float tx = (r.x > 0.0 ? size.x - o.x : o.x) * inv.x;
  float ty = (r.y > 0.0 ? size.y - o.y : o.y) * inv.y;
  float tz = (size.z - o.z) * inv.z;
  float t = min(min(tx, ty), tz);
  vec3 h = o + r * t;
  vec3 wall = kind > 1.5 ? vec3(0.78, 0.64, 0.5) : fPaint(fract(seed * 7.13));
  vec3 c;
  if (t == tz) {
    c = wall;
    // Add a seeded picture and dark baseboard to the rear wall.
    vec2 pic = vec2(size.x * (0.3 + 0.4 * fract(seed * 3.7)), size.y * 0.58);
    c = mix(c, fLamp(fract(seed * 5.1)) * 0.55, step(abs(h.x - pic.x), 0.32) * step(abs(h.y - pic.y), 0.24));
    c *= 0.55 + 0.45 * step(0.12, h.y);
  } else if (t == tx) {
    c = wall * 0.78;
  } else if (r.y < 0.0) {
    c = fFloor(fract(seed * 11.3));
    // Use a checkerboard floor for shops and a central rug for other interiors.
    if (kind > 0.5 && kind < 1.5) c = mix(vec3(0.12, 0.1, 0.16), vec3(0.7, 0.68, 0.74), mod(floor(h.x * 2.0) + floor(h.z * 2.0), 2.0));
    else c = mix(c, fPaint(fract(seed * 2.3)) * 0.7, step(abs(h.x - size.x * 0.5), size.x * 0.28) * step(abs(h.z - size.z * 0.5), size.z * 0.22));
  } else {
    c = vec3(0.92, 0.9, 0.95);
  }
  // Measure light falloff from a fixture near the ceiling center.
  vec3 d = h - vec3(size.x * 0.5, size.y - 0.3, size.z * 0.5);
  float fall = max(${f(LOOK.glowFloor)}, 1.0 / (1.0 + dot(d, d) * ${f(LOOK.falloff)}));
  // Sample an interior furniture card: room tiles 0-4 or empty 7, shop tiles 2 or 5, and lobby tile 6.
  float zc = size.z * mix(${f(LOOK.card[0])}, ${f(LOOK.card[1])}, fract(seed * 13.7));
  float tc = (zc - o.z) * inv.z;
  float pick = floor(fract(seed * 19.3) * 6.0);
  float tile = kind > 1.5 ? 6.0 : kind > 0.5 ? 2.0 + 3.0 * step(0.5, fract(seed * 17.1)) : pick > 4.5 ? 7.0 : pick;
  if (tc < t) {
    vec2 q = (o.xy + r.xy * tc - vec2(0.5 * (size.x - size.y), 0.0)) / size.y;
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
      float a = textureLod(uFurniture, vec2((mod(tile, 4.0) + q.x) * 0.25, (floor(tile / 4.0) + q.y) * 0.5), 0.0).a;
      c = mix(c, vec3(0.1, 0.07, 0.12), a);
      fall *= 1.0 - 0.8 * a;
    }
  }
  // Attenuate daylight with depth from the window.
  vec3 day = c * (1.0 - 0.45 * h.z / size.z);
  glow = lit ? c * lamp * fall : vec3(0.0);
  return day;
}
`;

const FRAG_BODY = /* glsl */ `
void facadePaint(inout vec3 col, vec3 wp) {
  float code = floor(vFaceData.w + 0.5);
  float kind = mod(code, 4.0);
  if (kind < 0.5) return;
  vec3 n = normalize(vFaceN);
  float style = mod(floor(code / ${f(FACE_CODE.style)}), 4.0);
  if (kind > 2.5) {
    // Align the awning stripes to the horizontal axis encoded by style.
    float s = (style < 0.5 ? wp.x : wp.z) / ${f(LOOK.stripe)};
    float w = fwidth(s);
    float st = smoothstep(0.25 - w, 0.25 + w, abs(fract(s) - 0.5));
    col = mix(col, vec3(0.82, 0.78, 0.86) * (0.6 + 0.4 * max(n.y, 0.0)), st);
    return;
  }
  // Apply matching nighttime emission to physical interior surfaces.
  if (kind > 1.5 && style > 0.5) {
    facEmit = col * ${f(LOOK.roomGlow)};
    return;
  }
  // Keep trim and horizontal wall faces free of window patterns.
  if (kind > 1.5 || abs(n.y) > 0.5) return;
  float street = mod(floor(code / ${f(FACE_CODE.street)}), 4.0);
  float storeys = mod(floor(code / ${f(FACE_CODE.storeys)}), 64.0);
  float door = floor(code / ${f(FACE_CODE.door)}) - 1.0;
  float bayW = vFaceData.x;
  float storeyH = vFaceData.y;
  float groundH = vFaceData.z;
  vec2 uv = vFaceUv;
  vec2 size = vec2(bayW, storeyH);
  vec2 px = max(fwidth(uv) * size, vec2(1e-4));
  vec2 aa = px * 0.7;
  float faceSeed = fHash(vec2(floor(dot(wp, n) * 4.0 + 0.5), n.x * 3.0 + n.z * 7.0 + 0.5));
  vec2 cell = floor(uv);
  float ground = step(uv.y, 0.0);
  // Convert bay UVs to meters above the lower-left corner, using the taller ground-floor height where needed.
  vec2 m = vec2(fract(uv.x) * bayW, ground > 0.5 ? uv.y * storeyH + groundH : fract(uv.y) * storeyH);
  float ceilH = ground > 0.5 ? groundH : storeyH;
  float floorY = 0.0;
  float rkind = 0.0;
  vec2 lo;
  vec2 hi;
  float sill = 0.0;
  float mull = 0.0;
  // Match ground-floor openings to the physical dimensions in FACADE.front.
  bool isDoor = ground > 0.5 && street > 0.5 && abs(cell.x - door) < 0.5;
  if (ground > 0.5 && street > 0.5 && street < 2.5) {
    rkind = street;
    if (street < 1.5) {
      // Replace the shop display opening with a narrower, lower glass opening in the door bay.
      lo = isDoor ? vec2(0.5 * (bayW - ${f(F.door)}), ${f(F.floor)}) : vec2(${f(F.shop.frame)}, ${f(F.shop.bulkhead)});
      hi = isDoor ? vec2(0.5 * (bayW + ${f(F.door)}), ${f(F.doorTop)}) : vec2(bayW - ${f(F.shop.frame)}, groundH - ${f(F.shop.fascia)});
      col = mix(col, col * 0.55, step(m.y, ${f(F.shop.bulkhead)}));
      col = mix(col, vec3(0.08, 0.05, 0.12), fBox(m, vec2(-1.0, groundH - ${f(F.shop.fascia)} + 0.1), vec2(bayW + 1.0, groundH - 0.2), aa));
    } else {
      // Add double-door mullions inside the lobby glazing at the encoded door bay.
      lo = vec2(${f(F.lobby.mullion)}, ${f(F.floor)});
      hi = vec2(bayW - ${f(F.lobby.mullion)}, groundH - ${f(F.lobby.head)});
      if (isDoor) mull = clamp(fBox(m, vec2(0.5 * bayW - 0.04, ${f(F.floor)}), vec2(0.5 * bayW + 0.04, ${f(F.doorTop)}), aa)
        + fBox(m, vec2(0.5 * bayW - ${f(F.door)}, ${f(F.doorTop)} - 0.04), vec2(0.5 * bayW + ${f(F.door)}, ${f(F.doorTop)} + 0.04), aa), 0.0, 1.0);
    }
    floorY = ${f(F.floor)};
  } else if (ground > 0.5) {
    // Raise ordinary ground-floor windows above the plinth and substitute a door opening in the entry bay.
    col = mix(col, col * 0.6, step(m.y, ${f(LOOK.plinth)}));
    lo = vec2(clamp(bayW * ${f(F.plain.pier)}, ${f(F.plain.pierMin)}, ${f(F.plain.pierMax)}), ${f(F.plain.sill)});
    hi = vec2(bayW - lo.x, groundH - ${f(F.plain.head)});
    sill = 1.0;
    if (isDoor) {
      lo = vec2(0.5 * (bayW - ${f(F.door)}), ${f(F.floor)});
      hi = vec2(0.5 * (bayW + ${f(F.door)}), ${f(F.doorTop)});
      sill = 0.0;
    }
    floorY = ${f(F.floor)};
  } else if (cell.y < storeys) {
    float sl = style < 0.5 ? ${f(G.sill[0])} : style < 1.5 ? ${f(G.sill[1])} : style < 2.5 ? ${f(G.sill[2])} : ${f(G.sill[3])};
    float hd = style < 0.5 ? ${f(G.head[0])} : style < 1.5 ? ${f(G.head[1])} : style < 2.5 ? ${f(G.head[2])} : ${f(G.head[3])};
    float side = style < 0.5 ? clamp(bayW * ${f(G.pier.share)}, ${f(G.pier.min)}, ${f(G.pier.max)}) : style < 2.5 && style > 1.5 ? ${f(G.pairPier)} : ${f(G.mullion)};
    lo = vec2(side, sl);
    hi = vec2(bayW - side, storeyH - hd);
    sill = style < 0.5 || (style > 1.5 && style < 2.5) ? 1.0 : 0.0;
    if (style > 1.5 && style < 2.5) mull = fBox(m, vec2(0.5 * bayW - ${f(G.pairMullion / 2)}, sl), vec2(0.5 * bayW + ${f(G.pairMullion / 2)}, storeyH - hd), aa);
    // Darken the spandrel bands between upper-floor windows for ribbon and grid styles.
    if (style > 0.5 && style < 1.5) col = mix(col, col * 0.7, 1.0 - step(sl, m.y) * step(m.y, storeyH - hd));
    if (style > 2.5) col = mix(col, vec3(0.1, 0.08, 0.16), step(m.y, sl) * fBox(m, vec2(0.0, 0.08), vec2(bayW, sl), aa) );
  } else {
    // Leave the wall above the configured window storeys unpatterned.
    return;
  }
  float t = max(${f(LOOK.frame)}, px.x * ${f(LOOK.framePx)});
  float glass = fBox(m, lo, hi, aa);
  float frame = clamp(fBox(m, lo - t, hi + t, aa) - glass, 0.0, 1.0);
  if (sill > 0.5) col = mix(col, col * 1.45, fBox(m, vec2(lo.x - ${f(LOOK.sillRun)}, lo.y - t - ${f(LOOK.sillHeight)}), vec2(hi.x + ${f(LOOK.sillRun)}, lo.y - t), aa));
  vec3 ink = vec3(0.07, 0.04, 0.1);
  col = mix(col, ink, frame);
  if (glass < 0.001) return;
  // Open facade glazing where physical interiors have been built.
  // Those interiors provide their own glass panes.
  if (glass > 0.5 && fLive(wp)) discard;

  // Share deterministic room dimensions and lighting across adjoining bays.
  float floorId = ground > 0.5 ? -1.0 : cell.y;
  float wide = step(fHash(vec2(floorId, faceSeed * 31.0)), 0.5) + 1.0;
  float unit = rkind > 0.5 ? ${f(LOOK.wideRoom)} : wide;
  float roomX = floor(cell.x / unit);
  float seed = fHash(vec2(roomX * 1.7 + faceSeed * 57.0, floorId * 3.1 + 0.5));
  float litK = rkind > 0.5 ? ${f(LOOK.litShop)} : ${f(LOOK.lit)} + ${f(LOOK.litSpread)} * fHash(vec2(floorId, faceSeed * 13.0));
  bool darkFloor = rkind < 0.5 && fHash(vec2(floorId * 2.3, faceSeed * 7.0)) < ${f(LOOK.darkFloor)};
  bool lit = !darkFloor && fract(seed * 23.7) < litK;
  vec3 lamp = rkind > 1.5 ? vec3(1.0, 0.78, 0.5) : fLamp(fract(seed * 29.3));
  float depth = rkind > 1.5 ? ${f(LOOK.depth[2])} : rkind > 0.5 ? ${f(LOOK.depth[1])} : ${f(LOOK.depth[0])};
  vec3 roomSize = vec3(bayW * unit, ceilH - floorY, depth);
  vec3 o = vec3(m.x + mod(cell.x, unit) * bayW, m.y - floorY, 0.0);

  vec3 glow = vec3(0.0);
  vec3 room;
  float far = smoothstep(${f(LOOK.farPx[0])}, ${f(LOOK.farPx[1])}, px.x);
  if (far < 0.999) {
    vec3 rd = isOrthographic ? -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : normalize(wp - cameraPosition);
    vec3 tng = normalize(cross(vec3(0.0, 1.0, 0.0), n));
    vec3 r = vec3(dot(rd, tng), rd.y, -dot(rd, n));
    room = fRoom(o, r, roomSize, seed, rkind, lit, lamp, glow);
    vec3 avg = fPaint(fract(seed * 7.13)) * 0.7;
    room = mix(room, avg, far);
    glow = mix(glow, lit ? avg * lamp * 0.6 : vec3(0.0), far);
  } else {
    room = fPaint(fract(seed * 7.13)) * 0.7;
    glow = lit ? room * lamp * 0.6 : vec3(0.0);
  }

  // Add partial blinds or side curtains to ordinary rooms according to the room seed.
  float wy = (m.y - lo.y) / max(hi.y - lo.y, 0.01);
  float wx = (m.x - lo.x) / max(hi.x - lo.x, 0.01);
  float cover = fract(seed * 41.9);
  float blind = rkind < 0.5 && cover < ${f(LOOK.blinds)} ? step(1.0 - mix(${f(LOOK.blindDrop[0])}, ${f(LOOK.blindDrop[1])}, fract(seed * 43.1)), wy) : 0.0;
  float curtain = rkind < 0.5 && cover > 1.0 - ${f(LOOK.curtains)} ? step(abs(wx - 0.5), 0.5) * step(0.32, abs(wx - 0.5)) : 0.0;
  vec3 cloth = fPaint(fract(seed * 47.3)) * 0.85;
  float slats = 0.6 + 0.4 * step(0.5, fract(m.y / 0.08));
  room = mix(room, cloth * slats, blind);
  room = mix(room, cloth, curtain);
  glow = mix(glow, lit ? cloth * lamp * 0.55 * slats : vec3(0.0), max(blind, curtain));

  // Blend the dimmed interior with sky reflection that increases toward the window top and a narrow sheen.
  vec3 sky = vec3(0.36, 0.36, 0.56);
  float refl = mix(${f(LOOK.reflect[0])}, ${f(LOOK.reflect[1])}, wy);
  float sheen = step(abs(fract((m.x + m.y * 0.7) / max(bayW, 1.0) + faceSeed) - 0.5), 0.05) * 0.25;
  vec3 g = mix(room * ${f(LOOK.dayRoom)}, sky, refl + sheen);
  col = mix(col, g, glass);
  col = mix(col, ink, mull * glass);
  facEmit = glow * ${f(LOOK.glow)} * glass * (1.0 - mull);
  facGlass = glass;
}
`;

/**
 * Build a four-by-two atlas of white furniture silhouettes on transparency.
 * Leave the final tile empty.
 */
function furnitureAtlas(): CanvasTexture {
  const T = 64;
  const { c, ctx } = makeCanvas(T * 4, T * 2);
  ctx.fillStyle = '#fff';

  /**
   * Return a rectangle drawing helper for tile k, using normalized coordinates
   * with Y increasing from the floor.
   */
  const tile = (
    k: number,
  ): ((x: number, y: number, w: number, h: number) => void) => {
    const x0 = (k % 4) * T;
    const floor = (Math.floor(k / 4) === 0 ? 2 : 1) * T;
    return (x, y, w, h) =>
      ctx.fillRect(x0 + x * T, floor - (y + h) * T, w * T, h * T);
  };

  const disc = (k: number, x: number, y: number, r: number): void => {
    ctx.beginPath();
    ctx.arc(
      (k % 4) * T + x * T,
      (Math.floor(k / 4) === 0 ? 2 : 1) * T - y * T,
      r * T,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  };

  // 0: sofa and a standing lamp
  let r = tile(0);
  r(0.15, 0, 0.6, 0.2);
  r(0.15, 0.2, 0.6, 0.12);
  r(0.1, 0, 0.08, 0.26);
  r(0.72, 0, 0.08, 0.26);
  r(0.86, 0, 0.02, 0.5);
  r(0.81, 0.5, 0.12, 0.08);
  // 1: dining table, two chairs, a hanging lamp
  r = tile(1);
  r(0.3, 0.22, 0.4, 0.04);
  r(0.33, 0, 0.03, 0.22);
  r(0.64, 0, 0.03, 0.22);
  r(0.18, 0, 0.03, 0.3);
  r(0.18, 0.14, 0.1, 0.03);
  r(0.79, 0, 0.03, 0.3);
  r(0.72, 0.14, 0.1, 0.03);
  r(0.49, 0.72, 0.02, 0.28);
  r(0.43, 0.66, 0.14, 0.07);
  // 2: shelves
  r = tile(2);
  r(0.06, 0, 0.36, 0.72);
  r(0.58, 0, 0.36, 0.72);
  // 3: a plant and an armchair
  r = tile(3);
  r(0.12, 0, 0.12, 0.12);
  disc(3, 0.18, 0.3, 0.14);
  disc(3, 0.1, 0.42, 0.08);
  disc(3, 0.26, 0.44, 0.09);
  r(0.5, 0, 0.32, 0.18);
  r(0.5, 0.18, 0.06, 0.2);
  r(0.76, 0.18, 0.06, 0.2);
  // 4: somebody standing at the window
  r = tile(4);
  r(0.4, 0, 0.18, 0.5);
  r(0.37, 0.28, 0.24, 0.22);
  disc(4, 0.49, 0.57, 0.08);
  // 5: shop counter and a till, shelves behind
  r = tile(5);
  r(0.1, 0, 0.8, 0.3);
  r(0.6, 0.3, 0.12, 0.08);
  r(0.05, 0.45, 0.9, 0.03);
  r(0.05, 0.62, 0.9, 0.03);
  // 6: lobby desk and a potted palm
  r = tile(6);
  r(0.3, 0, 0.4, 0.32);
  r(0.8, 0, 0.1, 0.1);
  r(0.84, 0.1, 0.02, 0.35);
  disc(6, 0.85, 0.5, 0.1);
  // 7: empty
  return toTexture(c, { srgb: false });
}

let atlas: CanvasTexture | null = null;

/**
 * Extend a world material's existing shader patches with facade rendering and
 * return the material. FACE_DATA controls windows, storefronts, awnings, and
 * interior mapping. Room emission uses the material's existing emissive
 * intensity so day/night channels continue to control brightness.
 */
export function withFacade<T extends MeshStandardMaterial>(mat: T): T {
  const tex = (atlas ??= furnitureAtlas());
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (
    shader: WebGLProgramParametersWithUniforms,
    renderer,
  ) => {
    prev(shader, renderer);
    shader.uniforms.uFurniture = { value: tex };
    Object.assign(shader.uniforms, facadeUniforms);
    shader.vertexShader =
      VERT_HEAD +
      shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n  vFaceData = ${FACE_DATA};\n  vFaceUv = uv;\n  vFaceN = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = (FRAG_HEAD + FRAG_BODY + shader.fragmentShader)
      .replace(
        '#include <alphamap_fragment>',
        '#include <alphamap_fragment>\n  facadePaint(diffuseColor.rgb, vCutWorld);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.3, facGlass);\n  metalnessFactor = mix(metalnessFactor, 0.25, facGlass);',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= facEmit;',
      );
  };

  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|facade1';
  return mat;
}
