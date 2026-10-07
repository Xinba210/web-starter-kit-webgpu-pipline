import { describe, expect, it } from 'vitest';
import { CameraChunkStreamer, type ChunkCoordinate, type ChunkTier } from './chunkStreamer.ts';

describe('CameraChunkStreamer', () => {
  it('keeps the camera cell active and biases prefetch demand forward', () => {
    const streamer = new CameraChunkStreamer(
      { load: () => 1, unload: () => undefined },
      { cellSize: 10, activeRadius: 0.5, prefetchRadius: 1.2, unloadRadius: 3, lookAheadCells: 1.5 },
    );
    const plan = streamer.plan({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    const tiers = new Map(plan.map((demand) => [demand.id, demand.tier]));
    expect(tiers.get('0:0')).toBe('active');
    expect(tiers.get('2:0')).toBe('prefetch');
    expect(tiers.has('-2:0')).toBe(false);
  });

  it('respects the per-update load budget and starts with the highest priority chunk', () => {
    const loaded: string[] = [];
    const streamer = new CameraChunkStreamer(
      {
        load: (coord) => {
          loaded.push(`${coord.x}:${coord.z}`);
          return loaded.length;
        },
        unload: () => undefined,
      },
      { cellSize: 10, activeRadius: 1.1, prefetchRadius: 1.1, unloadRadius: 2, lookAheadCells: 0, maxLoadsPerUpdate: 1 },
    );
    const snapshot = streamer.update({ x: 1, z: 1, forwardX: 0, forwardZ: 1 });
    expect(snapshot.loadsStarted).toBe(1);
    expect(loaded).toEqual(['0:0']);
    expect(streamer.residentIds()).toEqual(['0:0']);
  });

  it('keeps old chunks resident inside the unload hysteresis ring', () => {
    const unloaded: string[] = [];
    const streamer = new CameraChunkStreamer(
      {
        load: (coord) => `${coord.x}:${coord.z}`,
        unload: (_value, coord) => unloaded.push(`${coord.x}:${coord.z}`),
      },
      { cellSize: 10, activeRadius: 0.1, prefetchRadius: 0.1, unloadRadius: 2, lookAheadCells: 0, maxLoadsPerUpdate: 8, maxUnloadsPerUpdate: 8 },
    );
    streamer.update({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    streamer.update({ x: 11, z: 1, forwardX: 1, forwardZ: 0 });
    expect(streamer.residentIds()).toContain('0:0');
    streamer.update({ x: 31, z: 1, forwardX: 1, forwardZ: 0 });
    expect(streamer.residentIds()).not.toContain('0:0');
    expect(unloaded).toContain('0:0');
  });

  it('cancels obsolete async loads and releases a value that resolves after cancellation', async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const released: string[] = [];
    let first = true;
    const streamer = new CameraChunkStreamer(
      {
        load: (_coord: ChunkCoordinate, _tier: ChunkTier) => {
          if (!first) return 'next';
          first = false;
          return new Promise<string>((resolve) => { resolveFirst = resolve; });
        },
        unload: (value) => released.push(value),
      },
      { cellSize: 10, activeRadius: 0.1, prefetchRadius: 0.1, unloadRadius: 1, lookAheadCells: 0, maxLoadsPerUpdate: 1, maxUnloadsPerUpdate: 8 },
    );
    streamer.update({ x: 1, z: 1, forwardX: 1, forwardZ: 0 });
    const moved = streamer.update({ x: 31, z: 1, forwardX: 1, forwardZ: 0 });
    expect(moved.cancelledLoads).toBe(1);
    resolveFirst?.('late');
    await Promise.resolve();
    expect(released).toContain('late');
  });
});
