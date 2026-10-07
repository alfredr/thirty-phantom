import {
  Color,
  Matrix4,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';

/**
 * Where the moon sits across the iso sky band (0..1 of the width) when it is
 * up.
 */
export const MOON_X = 0.715;
/** How high it sits once risen (0..1 of the height). */
export const MOON_Y = 0.915;

/**
 * Composite a procedural sky before bloom. Flat isometric views fade distant
 * geometry into a screen-space sky band. Perspective views use world-oriented
 * angular coordinates and distance fog. Curved isometric views fill uncovered
 * pixels with sky and add haze near the planet horizon. DayNight controls
 * celestial visibility.
 */
export const SkyShader = {
  name: 'SkyShader',
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    tDepth: { value: null as Texture | null },
    invViewProj: { value: new Matrix4() },
    focus: { value: new Vector3() },
    upDir: { value: new Vector2(0, -1) },
    fade0: { value: 12 },
    fade1: { value: 20 },
    resolution: { value: new Vector2(1, 1) },
    time: { value: 0 },
    bandStart: { value: 0.8 },
    skyTop: { value: new Color('#0e0420') },
    skyHorizon: { value: new Color('#3a1660') },
    haze: { value: new Color('#2a1046') },
    hazeAmount: { value: 0.6 },
    skylineColor: { value: new Color('#120822') },
    skylineFar: { value: new Color('#24123c') },
    windowColor: { value: new Color('#ffcf73') },
    /**
     * How much of the distant skyline silhouette shows, 0..1 (the renderer can
     * drop it in a view).
     */
    skylineAmount: { value: 1 },
    /**
     * Projected planet outline packed as (radius, centreY, aspectScale,
     * enabled), with distances in UV units. The upper edge is y0 + sqrt(r^2 -
     * ((x - 0.5) * sx)^2). `planet` stores the world-space centre and radius;
     * `toCam` and `hazeFrom` control haze as the ground normal turns away from
     * the camera.
     */
    horizon: { value: new Vector4() },
    planet: { value: new Vector4() },
    toCam: { value: new Vector3(0, 1, 0) },
    hazeFrom: { value: 0.25 },
    windows: { value: 1 },
    stars: { value: 1 },
    cloudColor: { value: new Color('#3d2266') },
    cloudLight: { value: new Color('#8f6bd0') },
    clouds: { value: 0.8 },
    moonPos: { value: new Vector2(MOON_X, MOON_Y) },
    moonAlpha: { value: 1 },
    moonSize: { value: 0.07 },
    sunPos: { value: new Vector2(0.2, 0.9) },
    sunAlpha: { value: 0 },
    sunColor: { value: new Color('#ffd9a0') },
    scroll: { value: 0 },
    isPersp: { value: 0 },
    camPos: { value: new Vector3() },
    fogNear: { value: 45 },
    fogFar: { value: 150 },
    /** World directions toward the sun and moon (chase view). */
    sunDirW: { value: new Vector3(0, 1, 0) },
    moonDirW: { value: new Vector3(0, 0.1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 invViewProj;
    uniform vec3 focus;
    uniform vec2 upDir;
    uniform float fade0, fade1;
    uniform vec2 resolution;
    uniform float time;
    uniform float bandStart;
    uniform vec3 skyTop, skyHorizon, haze, skylineColor, skylineFar, windowColor, cloudColor, cloudLight, sunColor;
    uniform float hazeAmount, windows, stars, clouds, moonAlpha, moonSize, sunAlpha, scroll, skylineAmount;
    uniform vec4 horizon, planet;
    uniform vec3 toCam;
    uniform float hazeFrom;
    uniform vec2 moonPos, sunPos;
    uniform float isPersp, fogNear, fogFar;
    uniform vec3 camPos, sunDirW, moonDirW;
    varying vec2 vUv;
    const float TAU = 6.2831853;

    float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
    float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }

    // Return a deterministic building height and its cell coordinates for one skyline layer.
    float skyline(float x, float seed, float baseH, float varH, float width, out float cell, out float cx) {
      float xi = x / width;
      cell = floor(xi);
      cx = fract(xi);
      float h = baseH + varH * hash11(cell * 1.7 + seed);
      if (hash11(cell + seed * 3.1) > 0.82) h += varH * 0.8; // Raise selected buildings above the base height range.
      return h;
    }

    float cloudAt(vec2 q) { return fbm(vec2(q.x * 2.2 + time * 0.012, q.y * 5.0)); }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float aspect = resolution.x / resolution.y;
      float y = vUv.y;
      bool persp = isPersp > 0.5;
      float bandH = 1.0 - bandStart;
      float dz = texture2D(tDepth, vUv).x;
      vec4 wp = invViewProj * vec4(vUv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
      wp /= wp.w;

      // Use aspect-corrected screen coordinates in isometric views.
      // In perspective, use azimuth and bandStart plus elevation, both measured in radians.
      vec2 p;
      float by;
      vec3 ray = vec3(0.0, 0.0, 1.0);
      if (persp) {
        vec4 fp = invViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
        ray = normalize(fp.xyz / fp.w - camPos);
        float az = atan(ray.x, ray.z);
        if (az < 0.0) az += TAU;
        float el = asin(clamp(ray.y, -1.0, 1.0));
        p = vec2(az, bandStart + el);
        by = el / bandH;
      } else {
        p = vec2(vUv.x * aspect, y);
        // Start the sky at the projected planet outline, holding the baseline level beyond its sides.
        float hx = (vUv.x - 0.5) * horizon.z;
        float foot = horizon.w > 0.5 ? horizon.y + sqrt(max(horizon.x * horizon.x - hx * hx, 0.0)) : bandStart;
        by = (y - foot) / bandH;
      }

      vec3 sky = mix(skyHorizon, skyTop, smoothstep(0.0, 1.0, persp ? by * bandH / 0.55 : by));

      // Fade sparse, twinkling stars toward the horizon.
      vec2 sg = floor(p * vec2(220.0, 220.0));
      float st = hash21(sg);
      float twinkle = 0.6 + 0.4 * sin(time * 3.0 + st * 40.0);
      sky += vec3(0.9, 0.85, 1.0) * step(0.996, st) * twinkle * stars * smoothstep(0.1, 0.6, by);

      // Combine the solar disc with a broader glow.
      float sunR = persp ? acos(clamp(dot(ray, sunDirW), -1.0, 1.0)) : length(p - vec2(sunPos.x * aspect, sunPos.y));
      sky += sunColor * sunAlpha * (smoothstep(0.055, 0.05, sunR) * 2.5 + exp(-sunR * 9.0) * 0.6);

      // Shade the moon with procedural craters, directional rim light and a halo.
      vec2 md;
      float moonAng;
      if (persp) {
        // Project rays onto a tangent frame centered on the moon and aligned with world up.
        vec3 mx = normalize(cross(moonDirW, vec3(0.0, 1.0, 0.0)));
        vec3 my = cross(mx, moonDirW);
        float facing = dot(ray, moonDirW);
        md = facing > 0.0 ? vec2(dot(ray, mx), dot(ray, my)) / moonSize : vec2(1e3);
        moonAng = acos(clamp(facing, -1.0, 1.0));
      } else {
        md = (p - vec2(moonPos.x * aspect, moonPos.y)) / moonSize;
        moonAng = length(p - vec2(moonPos.x * aspect, moonPos.y));
      }
      float mr = length(md);
      float disc = smoothstep(1.0, 0.97, mr);
      float crater = fbm(md * 3.0 + 4.0);
      vec3 moonCol = mix(vec3(0.82, 0.78, 0.95), vec3(1.15, 1.1, 1.25), crater);
      moonCol *= 0.85 + 0.25 * smoothstep(0.2, 1.0, dot(normalize(md + 0.0001), vec2(0.6, 0.6)) * mr);
      sky += vec3(0.45, 0.35, 0.75) * exp(-max(mr - 1.0, 0.0) * 3.0) * 0.35 * moonAlpha;
      sky = mix(sky, moonCol * 0.82, disc * moonAlpha);

      // Drift cloud noise horizontally and brighten clouds near the moon.
      // Crossfade perspective cloud noise across the azimuth seam to keep the sky continuous.
      float cl = persp
        ? mix(cloudAt(p), cloudAt(p - vec2(TAU, 0.0)), smoothstep(TAU - 0.6, TAU, p.x))
        : fbm(vec2(p.x * 2.2 + time * 0.012 + scroll * 0.3, p.y * 5.0));
      float cmask = smoothstep(0.52, 0.78, cl) * clouds * smoothstep(0.05, 0.4, by) * (1.0 - smoothstep(0.85, 1.0, by) * 0.5);
      float lit = exp(-moonAng * 4.0) * moonAlpha + sunAlpha * 0.4;
      vec3 cc = mix(cloudColor, cloudLight, clamp(lit + (cl - 0.6) * 1.2, 0.0, 1.0));
      sky = mix(sky, cc, cmask * 0.9);

      // Offset two skyline layers for isometric parallax; perspective layers remain fixed in azimuth.
      // Make perspective building widths divide the full circle so cells meet at the seam.
      // Skip both layers when skylineAmount is zero to avoid a solid band below the horizon.
      float cell, cx;
      float sc = persp ? 0.0 : scroll;
      float xf = p.x * 1.0 + sc * 0.5;
      float hf = skyline(xf, 7.0, 0.16, 0.22, persp ? TAU / 140.0 : 0.045, cell, cx) * skylineAmount;
      if (skylineAmount > 0.0 && by < hf) sky = mix(sky, skylineFar, 0.9);
      float xn = p.x * 1.0 + sc;
      float hn = skyline(xn, 2.0, 0.06, 0.2, persp ? TAU / 90.0 : 0.07, cell, cx) * skylineAmount;
      if (skylineAmount > 0.0 && by < hn) {
        sky = skylineColor;
        // Light selected window cells while keeping the building edges dark.
        vec2 wg = vec2(cx * 5.0, by * 60.0);
        vec2 wi = floor(wg);
        float lit2 = step(0.62, hash21(wi + cell * 13.0));
        float inWin = step(0.25, fract(wg.x)) * step(fract(wg.x), 0.75) * step(0.3, fract(wg.y)) * step(fract(wg.y), 0.75);
        float edge = step(0.12, cx) * step(cx, 0.9);
        sky += windowColor * lit2 * inWin * edge * windows * 1.6;
      }

      if (persp) {
        // Blend the lower sky into the same haze color used for distance fog on scene geometry.
        sky = mix(sky, haze, smoothstep(0.0, -0.12, by));
        float hz = smoothstep(fogNear, fogFar, length(wp.xyz - camPos));
        vec3 world = mix(col.rgb, haze, hz);
        gl_FragColor = vec4(dz >= 0.99999 ? sky : world, 1.0);
        return;
      }

      // For curved views, haze surfaces as they turn away from the camera and show sky at background pixels.
      if (horizon.w > 0.5) {
        float facing = dot(normalize(wp.xyz - planet.xyz), toCam);
        vec3 world = mix(col.rgb, haze, hazeAmount * (1.0 - smoothstep(0.0, hazeFrom, facing)));
        gl_FragColor = vec4(dz >= 0.99999 ? sky : world, 1.0);
        return;
      }

      // In flat isometric views, fade by reconstructed ground-plane distance from the focus.
      // Only distant geometry transitions into the skyline; nearby towers and deck surfaces
      // remain in front regardless of their screen height.
      float dist = dot(wp.xz - focus.xz, upDir);
      float far = dz >= 0.99999 ? 1.0 : smoothstep(fade0 + (fade1 - fade0) * 0.55, fade1, dist);
      float hz = smoothstep(fade0, fade1, dist) * hazeAmount;
      vec3 world = mix(col.rgb, haze, hz);
      // Fade distant pixels below the sky band into haze.
      float skyK = far * smoothstep(bandStart - 0.12, bandStart + 0.02, y);
      vec3 under = mix(world, haze, far);
      gl_FragColor = vec4(mix(under, sky, skyK), 1.0);
    }
  `,
};

export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    resolution: { value: new Vector2(1, 1) },
    time: { value: 0 },
    exposure: { value: 1 },
    /**
     * Contrast about mid-grey in gamma space. Keep the increase small to
     * preserve detail in night shadows.
     */
    contrast: { value: 1.06 },
    /** Saturation multiplier in gamma space. */
    saturation: { value: 1.14 },
    /** Maximum fractional darkening at the corners in gamma space. */
    vignette: { value: 0.25 },
    /** Peak-to-peak film-grain amplitude in gamma space, randomized each frame. */
    grain: { value: 0.012 },
    /** Scale of radial red and blue channel offsets in UV coordinates. */
    aberration: { value: 0.0012 },
    flash: { value: 0 },
    flashColor: { value: new Color('#9dff3a') },
    shadowTint: { value: new Color('#05000a') },
  },
  vertexShader: SkyShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time, exposure, contrast, saturation, vignette, grain, aberration, flash;
    uniform vec3 flashColor, shadowTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    // Apply extended Reinhard tone mapping independently to each color channel.
    // Independent channel compression preserves more color in bright neon.
    vec3 tonemap(vec3 c) {
      const float W = 3.2;
      return c * (1.0 + c / (W * W)) / (1.0 + c);
    }
    void main() {
      vec2 cc = vUv - 0.5;
      float r2 = dot(cc, cc);
      vec2 off = cc * aberration * (0.2 + r2 * 2.5);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col += flashColor * flash;
      col = tonemap(col * exposure * 1.35);
      // Apply grading in approximate gamma space, then return to linear color.
      vec3 g = pow(max(col, 0.0), vec3(1.0 / 2.2));
      float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
      g = mix(vec3(lum), g, saturation);
      g = (g - 0.5) * contrast + 0.5;
      g += shadowTint * (1.0 - smoothstep(0.0, 0.25, lum));
      g *= mix(1.0, 1.0 - vignette, smoothstep(0.08, 0.5, r2));
      g += (hash(vUv * resolution + fract(time) * 100.0) - 0.5) * grain;
      col = pow(clamp(g, 0.0, 1.0), vec3(2.2));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
