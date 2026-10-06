import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { ChunkLightingRuntime } from './chunkLighting.ts';
import type { DecodedChunkLightmapPackage } from './chunkLightmapPackage.ts';

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

function packageValue(
  revision = 'fixture-v1',
  chartCount = 2,
  metresPerTexel = 0.05,
  tileSize = 64,
  border = 2,
): DecodedChunkLightmapPackage {
  return {
    revision,
    metresPerTexel,
    tileSize,
    border,
    fallbackWidth: 4,
    fallbackHeight: 4,
    fallback: new Uint16Array(4 * 4 * 4),
    index: {
      revision,
      charts: Array.from({ length: chartCount }, () => ({ tailLevel: 0, tileStart: 0, tileCount: 0 })),
      tiles: [],
    },
    storeBytes: 128,
    tile(localTile: number) {
      throw new Error(`XVLM has no tile ${localTile}`);
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const spec = {
  packageUrl: '/lighting/0-0.xvlm',
  chartCount: 2,
  revision: 'fixture-v1',
  metresPerTexel: 0.05,
};

describe('ChunkLightingRuntime', () => {
  it('allocates charts only after XVLM validation and restores local ids on reactivation', async () => {
    const loader = async (url: string) => url.includes('blocker')
      ? packageValue('blocker')
      : packageValue();
    const runtime = new ChunkLightingRuntime(8, 16, loader);
    const firstRoot = rootWithCharts();

    runtime.activate('0:0', firstRoot, spec);
    expect(runtime.get('0:0')?.state).toBe('loading');
    await settle();

    const first = runtime.get('0:0')!;
    const firstAttr = (firstRoot.children[0] as THREE.Mesh).geometry.getAttribute('lightmapChart');
    expect(first.state).toBe('ready');
    expect([firstAttr.getX(0), firstAttr.getX(1)]).toEqual([
      first.registered!.charts.base,
      first.registered!.charts.base + 1,
    ]);
    expect(runtime.snapshot()).toMatchObject({ chartsUsed: 2, activeChunks: 1, readyChunks: 1 });

    const firstBase = first.registered!.charts.base;
    runtime.deactivate('0:0');
    expect(runtime.snapshot()).toMatchObject({ chartsUsed: 0, activeChunks: 0 });

    const blocker = rootWithCharts();
    runtime.activate('blocker', blocker, {
      ...spec,
      packageUrl: '/lighting/blocker.xvlm',
      revision: 'blocker',
    });
    await settle();

    runtime.activate('0:0', firstRoot, spec);
    await settle();
    const second = runtime.get('0:0')!;
    const secondAttr = (firstRoot.children[0] as THREE.Mesh).geometry.getAttribute('lightmapChart');

    expect(second.registered!.charts.base).not.toBe(firstBase);
    expect([secondAttr.getX(0), secondAttr.getX(1)]).toEqual([
      second.registered!.charts.base,
      second.registered!.charts.base + 1,
    ]);
  });

  it('reports validated package identity and memory for diagnostics', async () => {
    const runtime = new ChunkLightingRuntime(16, 16, async () => packageValue());
    runtime.activate('4:2', rootWithCharts(), spec);
    await settle();

    expect(runtime.snapshot().chunks[0]).toMatchObject({
      owner: '4:2',
      state: 'ready',
      charts: 2,
      tiles: 0,
      revision: 'fixture-v1',
      packageUrl: '/lighting/0-0.xvlm',
      storeKiB: 0.1,
      remappedGeometries: 1,
    });
  });

  it('aborts a retired load and never registers its late package', async () => {
    let resolvePackage: ((value: DecodedChunkLightmapPackage) => void) | undefined;
    let signal: AbortSignal | undefined;
    const runtime = new ChunkLightingRuntime(8, 8, (_url, nextSignal) => {
      signal = nextSignal;
      return new Promise((resolve) => { resolvePackage = resolve; });
    });

    runtime.activate('0:0', rootWithCharts(), spec);
    runtime.deactivate('0:0');
    expect(signal?.aborted).toBe(true);

    resolvePackage?.(packageValue());
    await settle();

    expect(runtime.get('0:0')).toBeUndefined();
    expect(runtime.registry.snapshot()).toMatchObject({ chunks: 0, chartsUsed: 0, tilesUsed: 0 });
  });

  it('keeps mismatched packages out of the global registry', async () => {
    const runtime = new ChunkLightingRuntime(8, 8, async () => packageValue('wrong-revision'));
    runtime.activate('0:0', rootWithCharts(), spec);
    await settle();

    expect(runtime.get('0:0')).toMatchObject({ state: 'failed' });
    expect(runtime.get('0:0')?.error).toMatch(/revision mismatch/);
    expect(runtime.registry.snapshot()).toMatchObject({ chunks: 0, chartsUsed: 0, tilesUsed: 0 });
  });

  it('enforces one physical tile shape across active chunk packages', async () => {
    const runtime = new ChunkLightingRuntime(8, 8, async (url) => (
      url.includes('different') ? packageValue('different', 2, 0.05, 32, 2) : packageValue()
    ));
    runtime.activate('first', rootWithCharts(), spec);
    await settle();
    runtime.activate('different', rootWithCharts(), {
      ...spec,
      packageUrl: '/lighting/different.xvlm',
      revision: 'different',
    });
    await settle();

    expect(runtime.get('first')?.state).toBe('ready');
    expect(runtime.get('different')?.state).toBe('failed');
    expect(runtime.get('different')?.error).toMatch(/tile size mismatch/);
  });
});
