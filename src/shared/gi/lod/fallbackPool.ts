import * as THREE from 'three/webgpu';
import {
  extractChunkFallbackTile,
  type DecodedChunkLightmapPackage,
} from './chunkLightmapPackage.ts';
import {
  type RegisteredChunkLightmap,
  type WorldChartHandle,
  WorldLightmapRegistry,
} from './worldLightmapRegistry.ts';

interface PinnedFallbackRecord {
  owner: string;
  handle: WorldChartHandle;
}

export interface PinnedFallbackPlacement {
  chart: WorldChartHandle;
  slot: number;
}

export class PinnedFallbackResidency {
  readonly capacity: number;
  private readonly slots: Array<PinnedFallbackRecord | null>;
  private readonly ownerSlots = new Map<string, number[]>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('fallback capacity must be a positive integer');
    this.capacity = capacity;
    this.slots = Array.from({ length: capacity }, () => null);
  }

  pin(owner: string, charts: WorldChartHandle[], registry: WorldLightmapRegistry): PinnedFallbackPlacement[] {
    this.sweepStale(registry);
    this.release(owner);

    for (const chart of charts) {
      if (!registry.isCurrentChart(chart)) throw new Error(`cannot pin stale chart ${chart.slot}:${chart.generation}`);
    }

    const free: number[] = [];
    for (let slot = 0; slot < this.slots.length && free.length < charts.length; slot++) {
      if (this.slots[slot] === null) free.push(slot);
    }
    if (free.length < charts.length) throw new Error(`fallback pool exhausted: need ${charts.length}, free ${free.length}`);

    const placements = charts.map((chart, index) => ({ chart, slot: free[index] }));
    for (const placement of placements) {
      this.slots[placement.slot] = { owner, handle: placement.chart };
    }
    this.ownerSlots.set(owner, placements.map((placement) => placement.slot));
    return placements;
  }

  release(owner: string): number {
    const slots = this.ownerSlots.get(owner);
    if (!slots) return 0;
    this.ownerSlots.delete(owner);
    for (const slot of slots) this.slots[slot] = null;
    return slots.length;
  }

  sweepStale(registry: WorldLightmapRegistry): number {
    const staleOwners = new Set<string>();
    for (const record of this.slots) {
      if (record && !registry.isCurrentChart(record.handle)) staleOwners.add(record.owner);
    }
    let released = 0;
    for (const owner of staleOwners) released += this.release(owner);
    return released;
  }

  slotOf(handle: WorldChartHandle): number | undefined {
    for (let slot = 0; slot < this.slots.length; slot++) {
      const record = this.slots[slot];
      if (record?.handle.slot === handle.slot && record.handle.generation === handle.generation) return slot;
    }
    return undefined;
  }

  get pinned(): number {
    let count = 0;
    for (const slot of this.slots) if (slot !== null) count++;
    return count;
  }

  snapshot(): { capacity: number; pinned: number; free: number; owners: number } {
    return {
      capacity: this.capacity,
      pinned: this.pinned,
      free: this.capacity - this.pinned,
      owners: this.ownerSlots.size,
    };
  }
}

interface GpuBackend {
  device: GPUDevice;
  get(texture: THREE.Texture): { texture?: GPUTexture };
}

function target(renderer: THREE.WebGPURenderer, side: number): THREE.RenderTarget {
  const result = new THREE.RenderTarget(side, side, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    generateMipmaps: false,
  });
  result.texture.minFilter = result.texture.magFilter = THREE.LinearFilter;
  result.texture.colorSpace = THREE.NoColorSpace;
  renderer.initTexture(result.texture);
  return result;
}

export class PinnedFallbackPool {
  readonly physicalTile: number;
  readonly residency: PinnedFallbackResidency;
  readonly target: THREE.RenderTarget;
  readonly texture: THREE.Texture;
  readonly size: number;
  uploadedBytesLastPin = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    readonly tileSize: number,
    readonly border: number,
    readonly slotsPerSide: number,
  ) {
    if (!Number.isInteger(tileSize) || tileSize < 1) throw new Error('fallback tileSize must be positive');
    if (!Number.isInteger(border) || border < 0) throw new Error('fallback border must be non-negative');
    if (!Number.isInteger(slotsPerSide) || slotsPerSide < 1) throw new Error('fallback slotsPerSide must be positive');
    this.physicalTile = tileSize + border * 2;
    this.residency = new PinnedFallbackResidency(slotsPerSide * slotsPerSide);
    this.size = slotsPerSide * this.physicalTile;
    this.target = target(renderer, this.size);
    this.texture = this.target.texture;
  }

  pin(
    owner: string,
    packageValue: DecodedChunkLightmapPackage,
    registered: RegisteredChunkLightmap,
    registry: WorldLightmapRegistry,
  ): PinnedFallbackPlacement[] {
    if (packageValue.tileSize !== this.tileSize || packageValue.border !== this.border) {
      throw new Error(
        `fallback pool tile shape is ${this.tileSize}+${this.border * 2}, package is ${packageValue.tileSize}+${packageValue.border * 2}`,
      );
    }
    if (packageValue.index.charts.length !== registered.charts.count) {
      throw new Error('fallback chart count does not match registered chart range');
    }

    const handles = packageValue.index.charts.map((_, localChart) => registry.chartHandle(owner, localChart));
    const placements = this.residency.pin(owner, handles, registry);
    let bytes = 0;

    try {
      for (let localChart = 0; localChart < placements.length; localChart++) {
        const pixels = extractChunkFallbackTile(packageValue, localChart);
        this.write(placements[localChart].slot, pixels);
        bytes += pixels.byteLength;
      }
    } catch (error) {
      this.residency.release(owner);
      throw error;
    }

    this.uploadedBytesLastPin = bytes;
    return placements;
  }

  release(owner: string): number {
    return this.residency.release(owner);
  }

  snapshot(): {
    size: number;
    physicalTile: number;
    capacity: number;
    pinned: number;
    free: number;
    uploadedKiBLastPin: number;
  } {
    const state = this.residency.snapshot();
    return {
      size: this.size,
      physicalTile: this.physicalTile,
      capacity: state.capacity,
      pinned: state.pinned,
      free: state.free,
      uploadedKiBLastPin: +(this.uploadedBytesLastPin / 1024).toFixed(1),
    };
  }

  dispose(): void {
    this.target.dispose();
  }

  private write(slot: number, pixels: Uint16Array): void {
    const backend = this.renderer.backend as unknown as GpuBackend;
    const texture = backend.get(this.texture).texture;
    if (!texture) throw new Error('fallback pool GPU texture is unavailable');
    const x = (slot % this.slotsPerSide) * this.physicalTile;
    const y = Math.floor(slot / this.slotsPerSide) * this.physicalTile;
    backend.device.queue.writeTexture(
      { texture, origin: { x, y } },
      pixels.buffer as ArrayBuffer,
      { offset: pixels.byteOffset, bytesPerRow: this.physicalTile * 8 },
      { width: this.physicalTile, height: this.physicalTile },
    );
  }
}
