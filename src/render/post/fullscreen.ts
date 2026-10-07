/**
 * Vertex shader for a FullScreenQuad pass: the quad is already in clip space;
 * uv passes through.
 */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
