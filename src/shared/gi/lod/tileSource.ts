import * as THREE from 'three/webgpu';
import type { ChartPyramidSet } from './chartPyramids.ts';

const HALF_FLOAT_TEXEL_BYTES = 8;

export interface LightmapTileSource {
  readonly storeBytes: number;
  readonly tail: Uint16Array;
  tile(key: number): Uint16Array;
  dispose(): void;
}

export function floatPixelsToHalf(pixels: Float32Array): Uint16Array {
  const half = new Uint16Array(pixels.length);
  for (let index = 0; index < pixels.length; index++) half[index] = THREE.DataUtils.toHalfFloat(pixels[index]);
  return half;
}

export class MemoryLightmapTileSource implements LightmapTileSource {
  readonly tail: Uint16Array;
  readonly storeBytes: number;
  private tiles: Uint16Array[];

  constructor(pyramids: ChartPyramidSet) {
    this.tiles = pyramids.tiles.map((tile) => floatPixelsToHalf(tile.pixels));
    this.tail = floatPixelsToHalf(pyramids.tailPixels);
    this.storeBytes = this.tiles.reduce((bytes, tile) => bytes + tile.byteLength, 0) + this.tail.byteLength;
  }

  tile(key: number): Uint16Array {
    const tile = this.tiles[key];
    if (!tile) throw new Error(`[lod] lightmap tile source has no tile ${key}`);
    return tile;
  }

  dispose(): void {
    this.tiles = [];
  }
}

export function expectedTileBytes(pyramids: ChartPyramidSet): number {
  return pyramids.physicalTile * pyramids.physicalTile * HALF_FLOAT_TEXEL_BYTES;
}
