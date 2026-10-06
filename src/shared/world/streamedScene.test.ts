import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Mobility } from './mobility.ts';
import { StreamedSceneRuntime, type StreamedChunkPackage, type StreamedChunkProvider } from './streamedScene.ts';

function provider(disposed: string[] = []): StreamedChunkProvider {
  return {
    load(coord) {
      const activeRoot = new THREE.Group();
      activeRoot.name = `active-${coord.x}-${coord.z}`;
      activeRoot.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      const proxyRoot = new THREE.Group();
      proxyRoot.name = `proxy-${coord.x}-${coord.z}`;
      proxyRoot.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      return {
        activeRoot,
        proxyRoot,
        dispose: () => { disposed.push(`${coord.x}:${coord.z}`); },
      };
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('StreamedSceneRuntime', () => {
  it('attaches active geometry as movable GI geometry and hides its proxy', async () => {
    const scene = new THREE.Scene();
    const runtime = new StreamedSceneRuntime(scene, provider(), {
      cellSize: 10,
      activeRadius: 0.1,
      prefetchRadius: 0.1,
      unloadRadius: 2,
      lookAheadCells: 0,
      maxLoadsPerUpdate: 1,
    });

    runtime.updateSample({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    await settle();

    const active = scene.getObjectByName('active-0-0')!;
    const proxy = scene.getObjectByName('proxy-0-0')!;
    const activeMesh = active.children[0] as THREE.Mesh;
    const proxyMesh = proxy.children[0] as THREE.Mesh;

    expect(active.visible).toBe(true);
    expect(proxy.visible).toBe(false);
    expect(activeMesh.userData.mobility).toBe(Mobility.Movable);
    expect(activeMesh.userData.giExclude).toBe(false);
    expect(proxyMesh.userData.giExclude).toBe(true);
    expect(runtime.consumeChanges().dynamicMembershipChanged).toBe(true);
  });

  it('shows prefetch proxies without adding their geometry to GI', async () => {
    const scene = new THREE.Scene();
    const runtime = new StreamedSceneRuntime(scene, provider(), {
      cellSize: 10,
      activeRadius: 0.1,
      prefetchRadius: 1.2,
      unloadRadius: 4,
      lookAheadCells: 1.5,
      maxLoadsPerUpdate: 16,
    });

    runtime.updateSample({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    await settle();

    const active = scene.getObjectByName('active-2-0')!;
    const proxy = scene.getObjectByName('proxy-2-0')!;
    expect(active.visible).toBe(false);
    expect(proxy.visible).toBe(true);
    expect((proxy.children[0] as THREE.Mesh).userData.giExclude).toBe(true);
  });

  it('removes streamed geometry only after the unload hysteresis boundary', async () => {
    const disposed: string[] = [];
    const scene = new THREE.Scene();
    const runtime = new StreamedSceneRuntime(scene, provider(disposed), {
      cellSize: 10,
      activeRadius: 0.1,
      prefetchRadius: 0.1,
      unloadRadius: 2,
      lookAheadCells: 0,
      maxLoadsPerUpdate: 8,
      maxUnloadsPerUpdate: 8,
    });

    runtime.updateSample({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    await settle();
    runtime.consumeChanges();

    runtime.updateSample({ x: 11, z: 1, forwardX: 1, forwardZ: 0 });
    await settle();
    expect(scene.getObjectByName('active-0-0')).toBeDefined();

    runtime.updateSample({ x: 31, z: 1, forwardX: 1, forwardZ: 0 });
    await settle();
    expect(scene.getObjectByName('active-0-0')).toBeUndefined();
    expect(disposed).toContain('0:0');
    expect(runtime.consumeChanges().dynamicMembershipChanged).toBe(true);
  });

  it('disposes a cancelled late load without attaching it to the scene', async () => {
    const scene = new THREE.Scene();
    const disposed: string[] = [];
    let resolveFirst: ((value: StreamedChunkPackage) => void) | undefined;
    let first = true;
    const base = provider(disposed);
    const runtime = new StreamedSceneRuntime(scene, {
      load(coord, signal) {
        if (!first) return base.load(coord, signal);
        first = false;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    }, {
      cellSize: 10,
      activeRadius: 0.1,
      prefetchRadius: 0.1,
      unloadRadius: 1,
      lookAheadCells: 0,
      maxLoadsPerUpdate: 1,
      maxUnloadsPerUpdate: 8,
    });

    runtime.updateSample({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    runtime.updateSample({ x: 31, z: 1, forwardX: 1, forwardZ: 0 });

    const late = await base.load({ x: 0, z: 0 }, new AbortController().signal);
    resolveFirst?.(late);
    await settle();

    expect(scene.getObjectByName('active-0-0')).toBeUndefined();
    expect(disposed.filter((id) => id === '0:0')).toHaveLength(1);
  });
});
