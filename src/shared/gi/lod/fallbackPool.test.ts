import { describe, expect, it } from 'vitest';
import { PinnedFallbackResidency } from './fallbackPool.ts';
import { WorldLightmapRegistry } from './worldLightmapRegistry.ts';

function register(registry: WorldLightmapRegistry, owner: string, charts: number) {
  return registry.register(owner, {
    revision: `${owner}-v1`,
    charts: Array.from({ length: charts }, () => ({ tailLevel: 0, tileStart: 0, tileCount: 0 })),
    tiles: [],
  });
}

describe('PinnedFallbackResidency', () => {
  it('pins one non-evictable physical slot per active chart and releases by owner', () => {
    const registry = new WorldLightmapRegistry(8, 8);
    register(registry, '0:0', 2);
    const residency = new PinnedFallbackResidency(4);
    const charts = [registry.chartHandle('0:0', 0), registry.chartHandle('0:0', 1)];
    const placements = residency.pin('0:0', charts, registry);

    expect(placements).toHaveLength(2);
    expect(residency.snapshot()).toEqual({ capacity: 4, pinned: 2, free: 2, owners: 1 });
    expect(residency.slotOf(charts[0])).toBeDefined();
    expect(residency.release('0:0')).toBe(2);
    expect(residency.snapshot()).toEqual({ capacity: 4, pinned: 0, free: 4, owners: 0 });
  });

  it('sweeps a retired generation before a new chunk reuses its chart slot', () => {
    const registry = new WorldLightmapRegistry(1, 1);
    register(registry, 'old', 1);
    const stale = registry.chartHandle('old', 0);
    const residency = new PinnedFallbackResidency(1);
    residency.pin('old', [stale], registry);

    registry.unregister('old');
    register(registry, 'new', 1);
    const current = registry.chartHandle('new', 0);

    expect(current.slot).toBe(stale.slot);
    expect(current.generation).not.toBe(stale.generation);
    expect(residency.pin('new', [current], registry)).toEqual([{ chart: current, slot: 0 }]);
    expect(residency.slotOf(stale)).toBeUndefined();
    expect(residency.slotOf(current)).toBe(0);
  });

  it('refuses a stale chart handle without consuming capacity', () => {
    const registry = new WorldLightmapRegistry(2, 2);
    register(registry, 'retired', 1);
    const stale = registry.chartHandle('retired', 0);
    registry.unregister('retired');

    const residency = new PinnedFallbackResidency(2);
    expect(() => residency.pin('retired', [stale], registry)).toThrow(/stale chart/);
    expect(residency.snapshot()).toEqual({ capacity: 2, pinned: 0, free: 2, owners: 0 });
  });

  it('fails capacity atomically for a new owner', () => {
    const registry = new WorldLightmapRegistry(4, 4);
    register(registry, 'a', 1);
    register(registry, 'b', 2);
    const residency = new PinnedFallbackResidency(2);
    residency.pin('a', [registry.chartHandle('a', 0)], registry);
    const before = residency.snapshot();

    expect(() => residency.pin('b', [
      registry.chartHandle('b', 0),
      registry.chartHandle('b', 1),
    ], registry)).toThrow(/exhausted/);
    expect(residency.snapshot()).toEqual(before);
  });
});
