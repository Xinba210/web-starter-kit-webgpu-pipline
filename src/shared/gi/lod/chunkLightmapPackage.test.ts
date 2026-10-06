import { describe, expect, it } from 'vitest';
import {
  decodeChunkLightmapPackage,
  encodeChunkLightmapPackage,
  type ChunkLightmapPackageInput,
} from './chunkLightmapPackage.ts';

function input(): ChunkLightmapPackageInput {
  const tileSize = 4;
  const border = 1;
  const physical = tileSize + border * 2;
  return {
    revision: 'fixture-v1',
    metresPerTexel: 0.05,
    tileSize,
    border,
    fallbackWidth: 4,
    fallbackHeight: 2,
    fallback: new Uint16Array(4 * 2 * 4).map((_, index) => index + 1),
    charts: [{ tailLevel: 1, tileStart: 0, tileCount: 2 }],
    tiles: [
      {
        chart: 0,
        level: 0,
        tileX: 0,
        tileY: 0,
        parent: 1,
        pixels: new Uint16Array(physical * physical * 4).fill(0x3800),
      },
      {
        chart: 0,
        level: 1,
        tileX: 0,
        tileY: 0,
        parent: null,
        pixels: new Uint16Array(physical * physical * 4).fill(0x3c00),
      },
    ],
  };
}

describe('XVLM chunk lightmap package', () => {
  it('round-trips metadata, fallback and GPU-ready tile payloads', async () => {
    const source = input();
    const encoded = await encodeChunkLightmapPackage(source);
    const decoded = await decodeChunkLightmapPackage(encoded);

    expect(decoded.revision).toBe(source.revision);
    expect(decoded.metresPerTexel).toBe(source.metresPerTexel);
    expect(decoded.tileSize).toBe(source.tileSize);
    expect(decoded.border).toBe(source.border);
    expect(Array.from(decoded.fallback)).toEqual(Array.from(source.fallback));
    expect(decoded.index).toEqual({
      revision: source.revision,
      charts: source.charts,
      tiles: source.tiles.map(({ pixels: _pixels, ...tile }) => tile),
    });
    expect(Array.from(decoded.tile(0))).toEqual(Array.from(source.tiles[0].pixels));
    expect(Array.from(decoded.tile(1))).toEqual(Array.from(source.tiles[1].pixels));
    expect(() => decoded.tile(2)).toThrow(/no tile/);
  });

  it('rejects tampering through the package checksum', async () => {
    const encoded = await encodeChunkLightmapPackage(input());
    const bytes = new Uint8Array(encoded);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await expect(decodeChunkLightmapPackage(encoded)).rejects.toThrow(/checksum/);
  });

  it('supports a tail-only chunk with no fine tiles', async () => {
    const source = input();
    source.charts = [{ tailLevel: 0, tileStart: 0, tileCount: 0 }];
    source.tiles = [];
    const decoded = await decodeChunkLightmapPackage(await encodeChunkLightmapPackage(source));
    expect(decoded.index.tiles).toHaveLength(0);
    expect(decoded.fallback.byteLength).toBe(source.fallback.byteLength);
  });

  it('refuses malformed tile payload dimensions before encoding', async () => {
    const source = input();
    source.tiles[0].pixels = new Uint16Array(3);
    await expect(encodeChunkLightmapPackage(source)).rejects.toThrow(/expected/);
  });
});
