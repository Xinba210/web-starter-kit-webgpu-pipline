import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { ChunkLightingRuntime } from './chunkLighting.ts';

function rootWithCharts(): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute('lightmapChart', new THREE.Float32BufferAttribute([0, 1, 1], 1));
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  return root;
}

const spec = {
  packageUrl: '/lighting/0-0.xvlm',
  chartCount: 2,
  revision: 'fixture-v1',
  metresPerTexel: 0.05,
};

describe('ChunkLightingRuntime', () => {
  it('allocates charts only while a chunk is active and restores local ids on reactivation', () => {
    const runtime = new ChunkLightingRuntime(8);
    const firstRoot = rootWithCharts();
    runtime.activate('0:0', firstRoot, spec);
    const first = runtime.get('0:0')!;
    const firstAttr = (firstRoot.children[0] as THREE.Mesh).geometry.getAttribute('lightmapChart');
    expect([firstAttr.getX(0), firstAttr.getX(1)]).toEqual([first.allocation.base, first.allocation.base + 1]);
    expect(runtime.snapshot()).toMatchObject({ chartsUsed: 2, activeChunks: 1 });

    runtime.deactivate('0:0');
    expect(runtime.snapshot()).toMatchObject({ chartsUsed: 0, activeChunks: 0 });

    const blocker = rootWithCharts();
    runtime.activate('blocker', blocker, { ...spec, revision: 'blocker' });
    const secondRoot = firstRoot;
    runtime.activate('0:0', secondRoot, spec);
    const second = runtime.get('0:0')!;
    const secondAttr = (secondRoot.children[0] as THREE.Mesh).geometry.getAttribute('lightmapChart');
    expect(second.allocation.base).not.toBe(first.allocation.base);
    expect([secondAttr.getX(0), secondAttr.getX(1)]).toEqual([second.allocation.base, second.allocation.base + 1]);
  });

  it('reports package identity for diagnostics', () => {
    const runtime = new ChunkLightingRuntime(16);
    runtime.activate('4:2', rootWithCharts(), spec);
    expect(runtime.snapshot().chunks[0]).toMatchObject({
      owner: '4:2',
      charts: 2,
      revision: 'fixture-v1',
      packageUrl: '/lighting/0-0.xvlm',
      remappedGeometries: 1,
    });
  });
});
