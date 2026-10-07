import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  float,
  floor,
  int,
  ivec2,
  max,
  texture,
  textureLoad,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { PAGE_TABLE_WIDTH } from './tileResidency.ts';
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

function target(
  renderer: THREE.WebGPURenderer,
  width: number,
  height: number,
  type: THREE.TextureDataType,
  filter: THREE.MagnificationTextureFilter,
): THREE.RenderTarget {
  const result = new THREE.RenderTarget(width, height, {
    type,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    generateMipmaps: false,
  });
  result.texture.minFilter = result.texture.magFilter = filter;
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
  readonly pageTarget: THREE.RenderTarget;
  readonly pageTexture: THREE.Texture;
  readonly pageData: Float32Array;
  readonly chartCapacity: number;
  private readonly ownerCharts = new Map<string, WorldChartHandle[]>();
  uploadedBytesLastPin = 0;
  uploadedPageBytesLastChange = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    readonly tileSize: number,
    readonly border: number,
    readonly slotsPerSide: number,
    chartCapacity = 65536,
  ) {
    if (!Number.isInteger(tileSize) || tileSize < 1) throw new Error('fallback tileSize must be positive');
    if (!Number.isInteger(border) || border < 0) throw new Error('fallback border must be non-negative');
    if (!Number.isInteger(slotsPerSide) || slotsPerSide < 1) throw new Error('fallback slotsPerSide must be positive');
    this.physicalTile = tileSize + border * 2;
    this.residency = new PinnedFallbackResidency(slotsPerSide * slotsPerSide);
    this.size = slotsPerSide * this.physicalTile;
    this.target = target(renderer, this.size, this.size, THREE.HalfFloatType, THREE.LinearFilter);
    this.texture = this.target.texture;
    this.chartCapacity = chartCapacity;
    const rows = Math.ceil(chartCapacity / PAGE_TABLE_WIDTH);
    this.pageTarget = target(renderer, PAGE_TABLE_WIDTH, rows, THREE.FloatType, THREE.NearestFilter);
    this.pageTexture = this.pageTarget.texture;
    this.pageData = new Float32Array(PAGE_TABLE_WIDTH * rows * 4);
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

    this.ownerCharts.set(owner, placements.map((placement) => placement.chart));
    let from = Number.POSITIVE_INFINITY;
    let to = -1;
    for (let localChart = 0; localChart < placements.length; localChart++) {
      const placement = placements[localChart];
      const rect = packageValue.fallbackCharts[localChart];
      const at = placement.chart.slot * 4;
      this.pageData.set([placement.slot, 1, rect.width, rect.height], at);
      from = Math.min(from, placement.chart.slot);
      to = Math.max(to, placement.chart.slot);
    }
    if (to >= 0) this.uploadPageRange(from, to);

    this.uploadedBytesLastPin = bytes;
    return placements;
  }

  release(owner: string): number {
    const charts = this.ownerCharts.get(owner);
    if (charts) {
      let from = Number.POSITIVE_INFINITY;
      let to = -1;
      for (const chart of charts) {
        const at = chart.slot * 4;
        this.pageData.fill(0, at, at + 4);
        from = Math.min(from, chart.slot);
        to = Math.max(to, chart.slot);
      }
      this.ownerCharts.delete(owner);
      if (to >= 0) this.uploadPageRange(from, to);
    }
    return this.residency.release(owner);
  }

  snapshot(): {
    size: number;
    physicalTile: number;
    capacity: number;
    pinned: number;
    free: number;
    uploadedKiBLastPin: number;
    uploadedPageKiBLastChange: number;
  } {
    const state = this.residency.snapshot();
    return {
      size: this.size,
      physicalTile: this.physicalTile,
      capacity: state.capacity,
      pinned: state.pinned,
      free: state.free,
      uploadedKiBLastPin: +(this.uploadedBytesLastPin / 1024).toFixed(1),
      uploadedPageKiBLastChange: +(this.uploadedPageBytesLastChange / 1024).toFixed(1),
    };
  }

  sampler(): { sample: (uv1: THREE.Node) => THREE.Node } {
    const page = this.pageTexture;
    const pool = this.texture;
    const tableWidth = float(PAGE_TABLE_WIDTH);
    const slotsPerSide = float(this.slotsPerSide);
    const physical = float(this.physicalTile);
    const border = float(this.border);
    const poolExtent = vec2(this.size, this.size);

    const sample = Fn(([uv1]: [THREE.Node]) => {
      const chart = floor(attribute('lightmapChart', 'float').add(0.5));
      const record = vec4(textureLoad(page, ivec2(int(chart.mod(tableWidth)), int(floor(chart.div(tableWidth))))));
      const slot = record.x;
      const valid = record.y;
      const dimensions = max(record.zw, vec2(1));
      const slotOrigin = vec2(slot.mod(slotsPerSide), floor(slot.div(slotsPerSide))).mul(physical);
      const local = vec2(uv1).clamp(vec2(0), vec2(1)).mul(dimensions.sub(1)).add(0.5);
      const radiance = vec3(texture(pool, slotOrigin.add(border).add(local).div(poolExtent)).level(float(0)));
      return valid.greaterThan(0.5).select(radiance, vec3(0));
    });

    return { sample: (uv1: THREE.Node) => sample(uv1) };
  }

  dispose(): void {
    this.target.dispose();
    this.pageTarget.dispose();
  }

  private uploadPageRange(from: number, to: number): void {
    const firstRow = Math.floor(from / PAGE_TABLE_WIDTH);
    const lastRow = Math.floor(to / PAGE_TABLE_WIDTH);
    const rows = this.pageData.subarray(
      firstRow * PAGE_TABLE_WIDTH * 4,
      (lastRow + 1) * PAGE_TABLE_WIDTH * 4,
    );
    const backend = this.renderer.backend as unknown as GpuBackend;
    const texture = backend.get(this.pageTexture).texture;
    if (!texture) throw new Error('fallback page-table GPU texture is unavailable');
    backend.device.queue.writeTexture(
      { texture, origin: { x: 0, y: firstRow } },
      rows.buffer as ArrayBuffer,
      { offset: rows.byteOffset, bytesPerRow: PAGE_TABLE_WIDTH * 16 },
      { width: PAGE_TABLE_WIDTH, height: lastRow - firstRow + 1 },
    );
    this.uploadedPageBytesLastChange = rows.byteLength;
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
