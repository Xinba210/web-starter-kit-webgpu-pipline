import { describe, expect, it } from 'vitest';
import { ChartPyramidSet } from './chartPyramids.ts';
import { MemoryLightmapTileSource, expectedTileBytes } from './tileSource.ts';

function atlas(width: number, height: number): Float32Array {
  const pixels = new Float32Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0.25;
    pixels[i + 1] = 0.5;
    pixels[i + 2] = 0.75;
    pixels[i + 3] = 1;
  }
  return pixels;
}

describe('MemoryLightmapTileSource', () => {
  it('owns half-float tile and tail payloads independently of pyramid pixel storage', () => {
    const set = new ChartPyramidSet({
      pages: [atlas(128, 128)],
      pageSize: 128,
      regions: [{ x: 0, y: 0, width: 128, height: 128 }],
      tileSize: 32,
    });
    const source = new MemoryLightmapTileSource(set);
    const first = source.tile(0);
    expect(first.byteLength).toBe(expectedTileBytes(set));
    expect(source.tail.byteLength).toBe(set.tailSize * set.tailSize * 8);
    expect(source.storeBytes).toBe(set.tiles.length * expectedTileBytes(set) + source.tail.byteLength);

    set.releasePixels();
    expect(source.tile(0).byteLength).toBe(expectedTileBytes(set));
    expect(source.tail.byteLength).toBeGreaterThan(0);
  });

  it('releases retained tile payloads when disposed', () => {
    const set = new ChartPyramidSet({
      pages: [atlas(128, 128)],
      pageSize: 128,
      regions: [{ x: 0, y: 0, width: 128, height: 128 }],
      tileSize: 32,
    });
    const source = new MemoryLightmapTileSource(set);
    source.dispose();
    expect(() => source.tile(0)).toThrow(/no tile/);
  });
});
