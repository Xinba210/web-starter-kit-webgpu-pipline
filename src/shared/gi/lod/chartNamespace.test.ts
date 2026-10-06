import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { ChartNamespace, remapLightmapCharts } from './chartNamespace.ts';

describe('ChartNamespace', () => {
  it('allocates non-overlapping ranges and reuses released space', () => {
    const namespace = new ChartNamespace(16);
    const a = namespace.allocate('0:0', 4);
    const b = namespace.allocate('1:0', 6);
    expect(a).toMatchObject({ base: 0, count: 4 });
    expect(b).toMatchObject({ base: 4, count: 6 });
    expect(namespace.used).toBe(10);

    namespace.release('0:0');
    const c = namespace.allocate('2:0', 3);
    expect(c.base).toBe(0);
    expect(c.generation).toBeGreaterThan(a.generation);
  });

  it('coalesces adjacent released ranges', () => {
    const namespace = new ChartNamespace(12);
    namespace.allocate('a', 3);
    namespace.allocate('b', 4);
    namespace.allocate('c', 5);
    namespace.release('b');
    namespace.release('a');
    namespace.release('c');
    expect(namespace.snapshot()).toMatchObject({ used: 0, free: 12 });
    expect(namespace.allocate('whole', 12).base).toBe(0);
  });

  it('refuses over-capacity allocations without corrupting existing owners', () => {
    const namespace = new ChartNamespace(4);
    namespace.allocate('a', 3);
    expect(() => namespace.allocate('b', 2)).toThrow(/exhausted/);
    expect(namespace.get('a')).toMatchObject({ base: 0, count: 3 });
    expect(namespace.freeCount).toBe(1);
  });
});

describe('remapLightmapCharts', () => {
  it('moves local chart ids into the allocated global range exactly once per shared geometry', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ], 3));
    geometry.setAttribute('lightmapChart', new THREE.Float32BufferAttribute([0, 1, 1], 1));
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));

    const count = remapLightmapCharts(root, { owner: '4:2', base: 20, count: 2, generation: 1 });
    expect(count).toBe(1);
    const remapped = geometry.getAttribute('lightmapChart');
    expect([remapped.getX(0), remapped.getX(1), remapped.getX(2)]).toEqual([20, 21, 21]);
    expect(geometry.userData.chunkLightmapOwner).toBe('4:2');
  });

  it('rejects a local chart id outside the chunk allocation', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('lightmapChart', new THREE.Float32BufferAttribute([2], 1));
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    expect(() => remapLightmapCharts(root, { owner: 'bad', base: 0, count: 2, generation: 1 })).toThrow(/exceeds chunk chart count/);
  });
});
