import { describe, expect, it } from 'vitest';
import { WorldLightmapRegistry, type ChunkLightmapIndex } from './worldLightmapRegistry.ts';

function index(revision = 'v1'): ChunkLightmapIndex {
  return {
    revision,
    charts: [
      { tailLevel: 2, tileStart: 0, tileCount: 2 },
      { tailLevel: 1, tileStart: 2, tileCount: 1 },
    ],
    tiles: [
      { chart: 0, level: 0, tileX: 0, tileY: 0, parent: 1 },
      { chart: 0, level: 1, tileX: 0, tileY: 0, parent: null },
      { chart: 1, level: 0, tileX: 0, tileY: 0, parent: null },
    ],
  };
}

describe('WorldLightmapRegistry', () => {
  it('maps local chart and tile indices into fixed global ranges', () => {
    const registry = new WorldLightmapRegistry(8, 16);
    const registered = registry.register('0:0', index());
    expect(registry.globalChart('0:0', 0)).toBe(registered.charts.base);
    expect(registry.globalChart('0:0', 1)).toBe(registered.charts.base + 1);

    const first = registry.tileHandle('0:0', 0);
    const parent = registry.tileHandle('0:0', 1);
    expect(registry.tileChart[first.slot]).toBe(registered.charts.base);
    expect(registry.tileParent[first.slot]).toBe(parent.slot);
    expect(registry.tileLevel[first.slot]).toBe(0);
    expect(registry.isCurrent(first)).toBe(true);
  });

  it('invalidates stale tile handles when a retired range is reused', () => {
    const registry = new WorldLightmapRegistry(4, 4);
    registry.register('old', {
      revision: 'old-v1',
      charts: [{ tailLevel: 1, tileStart: 0, tileCount: 1 }],
      tiles: [{ chart: 0, level: 0, tileX: 0, tileY: 0, parent: null }],
    });
    const stale = registry.tileHandle('old', 0);
    const staleSlot = stale.slot;

    expect(registry.unregister('old')).toBe(true);
    expect(registry.isCurrent(stale)).toBe(false);

    registry.register('new', {
      revision: 'new-v1',
      charts: [{ tailLevel: 1, tileStart: 0, tileCount: 1 }],
      tiles: [{ chart: 0, level: 0, tileX: 3, tileY: 2, parent: null }],
    });
    const current = registry.tileHandle('new', 0);

    expect(current.slot).toBe(staleSlot);
    expect(current.generation).not.toBe(stale.generation);
    expect(registry.isCurrent(stale)).toBe(false);
    expect(registry.isCurrent(current)).toBe(true);
    expect(registry.tileX[current.slot]).toBe(3);
    expect(registry.tileY[current.slot]).toBe(2);
  });

  it('rolls back chart allocation if tile capacity cannot satisfy a registration', () => {
    const registry = new WorldLightmapRegistry(8, 2);
    registry.register('kept', {
      revision: 'kept',
      charts: [{ tailLevel: 1, tileStart: 0, tileCount: 2 }],
      tiles: [
        { chart: 0, level: 0, tileX: 0, tileY: 0, parent: null },
        { chart: 0, level: 0, tileX: 1, tileY: 0, parent: null },
      ],
    });
    const before = registry.snapshot();

    expect(() => registry.register('blocked', index('blocked'))).toThrow(/exhausted/);
    expect(registry.snapshot()).toEqual(before);
    expect(registry.get('blocked')).toBeUndefined();
  });

  it('supports tail-only chunks without inventing a usable fine tile', () => {
    const registry = new WorldLightmapRegistry(4, 4);
    const registered = registry.register('tail-only', {
      revision: 'tail-v1',
      charts: [{ tailLevel: 0, tileStart: 0, tileCount: 0 }],
      tiles: [],
    });
    expect(registered.tileCount).toBe(0);
    expect(registry.snapshot()).toMatchObject({ chunks: 1, chartsUsed: 1, tilesUsed: 1 });
    expect(() => registry.tileHandle('tail-only', 0)).toThrow(/outside/);
  });

  it('replaces a changed revision with a fresh generation', () => {
    const registry = new WorldLightmapRegistry(8, 16);
    const first = registry.register('0:0', index('v1'));
    const handle = registry.tileHandle('0:0', 0);
    const second = registry.register('0:0', index('v2'));
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(registry.isCurrent(handle)).toBe(false);
    expect(second.revision).toBe('v2');
  });
});
