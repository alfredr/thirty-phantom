import {
  type AnimationClip,
  Box3,
  Color,
  Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  type Object3D,
  Sphere,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import {
  atSedanScale,
  buildCarRig,
  SEDAN,
  SEDAN_SCALE,
} from '@/actors/models/car';
import {
  type CharacterModel,
  GltfCharacter,
  ProceduralCharacter,
} from '@/actors/models/character';
import {
  isFrontWheel,
  type VehicleRig,
  WHEELS,
  type WheelRig,
} from '@/actors/models/rig';
import { addUnderglow, buildTruckRig } from '@/actors/models/truck';
import { urlFlag } from '@/engine/core/url-flags';
import { truckLivery } from '@/render/livery';
import { softInk, withCutaway } from '@/render/materials';

export type ModelKey = 'monsterTruck' | 'car' | 'cody';

/**
 * Disable shadow casting for meshes whose bounding radius is below this
 * fraction of the full model. Small details add shadow draw calls with little
 * visible benefit.
 */
const SMALL_CASTER = 0.12;

interface Manifest {
  models: Partial<Record<ModelKey, string | null>>;
}

interface Loaded {
  scene: Object3D;
  clips: AnimationClip[];
}

/**
 * Load optional GLB actor models from public/assets/manifest.json, with
 * procedural fallbacks for missing or failed assets.
 *
 * Models use meters, +Y up, +Z forward, and an origin at ground center.
 * Vehicle wheels use wheel_fl, wheel_fr, wheel_rl, and wheel_rr nodes at axle
 * centers; a body node supports suspension motion. Cody models provide idle,
 * walk, and run animations with day_* and night_* outfit meshes. Material
 * names identify paint, livery_side, hood, headlight, and taillight roles.
 */
export class AssetRegistry {
  private readonly models = new Map<ModelKey, Loaded>();

  static async load(base = 'assets/'): Promise<AssetRegistry> {
    const reg = new AssetRegistry();
    if (urlFlag('boxes')) {
      return reg;
    } // Explicitly disable GLB loading.

    let manifest: Manifest = { models: {} };
    try {
      const r = await fetch(`${base}manifest.json`);
      if (r.ok) {
        manifest = (await r.json()) as Manifest;
      }
    } catch {
      /* Use procedural models when the manifest is unavailable. */
    }

    const loader = new GLTFLoader();
    await Promise.all(
      (Object.entries(manifest.models) as [ModelKey, string | null][]).map(
        async ([key, file]) => {
          if (!file) {
            return;
          }

          try {
            const gltf = await loader.loadAsync(`${base}${file}`);
            gltf.scene.updateMatrixWorld(true);
            const whole = new Box3()
              .setFromObject(gltf.scene)
              .getBoundingSphere(new Sphere()).radius;
            gltf.scene.traverse((o) => {
              const m = o as Mesh;
              if (!m.isMesh) {
                return;
              }

              m.geometry.computeBoundingSphere();
              const r =
                (m.geometry.boundingSphere?.radius ?? 0) *
                m.matrixWorld.getMaxScaleOnAxis();
              m.castShadow = r >= whole * SMALL_CASTER;
              m.receiveShadow = true;
              const mats = Array.isArray(m.material)
                ? m.material
                : [m.material];
              mats.forEach((mm: Material) => {
                withCutaway(mm);

                if (baseName(mm.name) === 'slime') {
                  softInk(mm);
                }
              });
            });
            reg.models.set(key, { scene: gltf.scene, clips: gltf.animations });
            console.info(`[assets] ${key} <- ${file}`);
          } catch (err) {
            console.warn(
              `[assets] failed to load ${file}, using procedural ${key}`,
              err,
            );
          }
        },
      ),
    );
    return reg;
  }

  has(key: ModelKey): boolean {
    return this.models.has(key);
  }

  character(): CharacterModel {
    const src = this.models.get('cody');
    if (!src) {
      return new ProceduralCharacter();
    }

    return new GltfCharacter(cloneSkinned(src.scene), src.clips);
  }

  truckRig(): VehicleRig {
    const src = this.models.get('monsterTruck');
    if (!src) {
      return buildTruckRig();
    }

    const rig = vehicleFromGltf(src.scene.clone(true), 4.25, (name, m) => {
      const liv = truckLivery();
      if (name === 'livery_side') {
        return liveryMat(m, liv.side.map, liv.side.emissive);
      }

      if (name === 'hood') {
        return liveryMat(m, liv.cab.map, liv.cab.emissive);
      }

      return null;
    });
    addUnderglow(rig);
    return rig;
  }

  carRig(color: string): VehicleRig {
    const src = this.models.get('car');
    if (!src) {
      return buildCarRig(color);
    }

    // Match the procedural sedan scale and its collision dimensions.
    const rig = vehicleFromGltf(
      src.scene.clone(true),
      SEDAN.height * SEDAN_SCALE,
      (name, m) => {
        if (name === 'paint') {
          const p = m.clone();
          p.color.set(color);
          return p;
        }

        return null;
      },
    );
    return atSedanScale(rig);
  }
}

function liveryMat(
  base: MeshStandardMaterial,
  map: MeshStandardMaterial['map'],
  emissive: MeshStandardMaterial['emissiveMap'],
): MeshStandardMaterial {
  const m = withCutaway(
    new MeshStandardMaterial({
      map,
      emissiveMap: emissive,
      emissive: new Color('#ffffff'),
      emissiveIntensity: 0.9,
      roughness: base.roughness,
      metalness: base.metalness,
    }),
  );
  m.name = base.name;
  return m;
}

/**
 * Remove Blender numeric name suffixes, including the dotless form produced by
 * GLTFLoader.
 */
function baseName(n: string): string {
  return n.replace(/\.?\d{3}$/, '');
}

function vehicleFromGltf(
  scene: Object3D,
  height: number,
  remap: (
    name: string,
    m: MeshStandardMaterial,
  ) => MeshStandardMaterial | null,
): VehicleRig {
  const root = new Group();
  root.add(scene);
  const lights: MeshStandardMaterial[] = [];
  const materials: Material[] = [];
  const swapped = new Map<Material, Material>();
  scene.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) {
      return;
    }

    const fix = (mm: Material): Material => {
      const hit = swapped.get(mm);
      if (hit) {
        return hit;
      }

      const std = mm as MeshStandardMaterial;
      let out: MeshStandardMaterial = std;
      const r = std.isMeshStandardMaterial
        ? remap(baseName(std.name), std)
        : null;
      if (r) {
        out = withCutaway(r);
      } else if (std.name === 'headlight' || std.name === 'taillight') {
        out = withCutaway(std.clone());
      }

      if (out.name === 'headlight' || out.name === 'taillight') {
        lights.push(out);
      }

      swapped.set(mm, out);
      materials.push(out);
      return out;
    };

    m.material = Array.isArray(m.material)
      ? m.material.map(fix)
      : fix(m.material);
  });

  const find = (prefix: string): Object3D | null => {
    let hit: Object3D | null = null;
    scene.traverse((o) => {
      if (!hit && baseName(o.name) === prefix) {
        hit = o;
      }
    });
    return hit;
  };

  const body = (find('body') as Group | null) ?? new Group();
  if (!body.parent) {
    root.add(body);
  }

  const wheels: WheelRig[] = [];
  for (const name of WHEELS) {
    const node = find(name);
    if (!node?.parent) {
      continue;
    }

    const pivot = new Group();
    pivot.position.copy(node.position);
    node.parent.add(pivot);
    const spin = new Group();
    pivot.add(spin);
    spin.add(node);
    node.position.set(0, 0, 0);
    const size = new Box3().setFromObject(node).getSize(new Vector3());
    wheels.push({
      pivot,
      spin,
      front: isFrontWheel(name),
      radius: Math.max(0.2, size.y / 2),
    });
  }

  return { root, body, wheels, lights, materials, height, scale: 1 };
}
