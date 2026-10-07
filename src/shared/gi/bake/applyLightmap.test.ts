import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { applyLightmap, emissionBeforeLightmap, removeLightmap } from './applyLightmap.ts';

function receiver(withChart = true) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute('uv1', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    0, 1,
  ], 2));
  if (withChart) geometry.setAttribute('lightmapChart', new THREE.Float32BufferAttribute([0, 0, 0], 1));
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.streamedChunkRole = 'active';
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh, material };
}

describe('applyLightmap streamed receiver lifecycle', () => {
  it('binds a custom virtual sampler and restores the original emissive node', () => {
    const { root, mesh, material } = receiver();
    const lightmap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const original = material.emissiveNode ?? null;

    const applied = applyLightmap(
      root,
      lightmap,
      uniform(1),
      { sample: () => vec3(0.5) },
      (candidate) => candidate.userData.streamedChunkRole === 'active',
    );

    expect(applied).toBe(1);
    expect(mesh.userData.bakedLightReceiver).toBe(true);
    expect(material.userData.lightmapApplied).toBe(true);
    expect(material.emissiveNode).not.toBe(original);
    expect(emissionBeforeLightmap(material)).toBe(original);

    expect(removeLightmap(root)).toBe(1);
    expect(mesh.userData.bakedLightReceiver).toBe(false);
    expect(material.userData.lightmapApplied).toBe(false);
    expect(material.emissiveNode ?? null).toBe(original);
    expect(emissionBeforeLightmap(material)).toBeUndefined();
  });

  it('refuses virtual sampling without lightmapChart', () => {
    const { root, mesh, material } = receiver(false);
    const lightmap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

    const applied = applyLightmap(
      root,
      lightmap,
      uniform(1),
      { sample: () => vec3(1) },
      () => true,
    );

    expect(applied).toBe(0);
    expect(mesh.userData.bakedLightReceiver).not.toBe(true);
    expect(material.userData.lightmapApplied).not.toBe(true);
  });
});
