import { BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, type Material, Matrix4, Quaternion, Vector3 } from 'three';
import { TAU } from '../core/math';

interface P {
  pos: Vector3;
  vel: Vector3;
  spin: Vector3;
  rot: Vector3;
  size: number;
  life: number;
  max: number;
  floor: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _e = new Vector3();

/** Instanced cube particles: slime splats, concrete debris. They bounce on the floor they spawned over. */
export class CubeParticles {
  readonly mesh: InstancedMesh;
  private readonly ps: P[] = [];
  private cursor = 0;

  constructor(
    material: Material,
    max = 500,
    private readonly gravity = 28,
  ) {
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material, max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    const black = new Color(0, 0, 0);
    for (let i = 0; i < max; i++) {
      this.ps.push({ pos: new Vector3(), vel: new Vector3(), spin: new Vector3(), rot: new Vector3(), size: 0, life: 0, max: 1, floor: 0 });
      this.mesh.setColorAt(i, black);
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
  }

  /** One particle. Its color goes straight into the instance colors: it never changes after this. */
  spawn(pos: Vector3, vel: Vector3, size: number, life: number, color: Color, floor = pos.y): void {
    const i = this.cursor;
    const p = this.ps[i] as P;
    this.cursor = (i + 1) % this.ps.length;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
    p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    p.size = size;
    p.life = life;
    p.max = life;
    p.floor = floor;
  }

  burst(at: Vector3, n: number, speed: number, size: [number, number], life: [number, number], color: Color, up = 1, floor = at.y): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.3 + Math.random() * 0.7);
      _e.set(Math.cos(a) * s, (0.5 + Math.random()) * speed * 0.8 * up, Math.sin(a) * s);
      const sz = size[0] + Math.random() * (size[1] - size[0]);
      this.spawn(at, _e, sz, life[0] + Math.random() * (life[1] - life[0]), color, floor);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i] as P;
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vel.y -= this.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < p.floor + p.size * 0.5) {
        p.pos.y = p.floor + p.size * 0.5;
        p.vel.y *= -0.35;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
        p.spin.multiplyScalar(0.5);
      }
      p.rot.addScaledVector(p.spin, dt);
      const k = p.life <= 0 ? 0 : Math.min(1, p.life / (p.max * 0.35)) * p.size;
      _q.setFromAxisAngle(_e.set(p.rot.x, p.rot.y, p.rot.z).normalize(), p.rot.length());
      _m.compose(p.pos, _q, _s.setScalar(k));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
