import { ChartNamespace, type ChartAllocation } from './chartNamespace.ts';

export interface ChunkChartIndexRecord {
  tailLevel: number;
  tileStart: number;
  tileCount: number;
}

export interface ChunkTileIndexRecord {
  chart: number;
  level: number;
  tileX: number;
  tileY: number;
  parent: number | null;
}

export interface ChunkLightmapIndex {
  revision: string;
  charts: ChunkChartIndexRecord[];
  tiles: ChunkTileIndexRecord[];
}

export interface WorldTileHandle {
  slot: number;
  generation: number;
}

export interface RegisteredChunkLightmap {
  owner: string;
  revision: string;
  generation: number;
  charts: ChartAllocation;
  tiles: ChartAllocation;
}

export class WorldLightmapRegistry {
  readonly chartSlots: ChartNamespace;
  readonly tileSlots: ChartNamespace;
  readonly chartGeneration: Uint32Array;
  readonly tileGeneration: Uint32Array;
  readonly tileChart: Int32Array;
  readonly tileParent: Int32Array;
  readonly tileLevel: Uint8Array;
  readonly tileX: Uint16Array;
  readonly tileY: Uint16Array;

  private readonly chunks = new Map<string, RegisteredChunkLightmap>();
  private generation = 0;

  constructor(readonly chartCapacity: number, readonly tileCapacity: number) {
    this.chartSlots = new ChartNamespace(chartCapacity);
    this.tileSlots = new ChartNamespace(tileCapacity);
    this.chartGeneration = new Uint32Array(chartCapacity);
    this.tileGeneration = new Uint32Array(tileCapacity);
    this.tileChart = new Int32Array(tileCapacity).fill(-1);
    this.tileParent = new Int32Array(tileCapacity).fill(-1);
    this.tileLevel = new Uint8Array(tileCapacity);
    this.tileX = new Uint16Array(tileCapacity);
    this.tileY = new Uint16Array(tileCapacity);
  }

  register(owner: string, index: ChunkLightmapIndex): RegisteredChunkLightmap {
    if (!index.revision.trim()) throw new Error(`chunk lightmap ${owner} has no revision`);
    if (index.charts.length < 1) throw new Error(`chunk lightmap ${owner} has no charts`);
    this.validate(index);

    const existing = this.chunks.get(owner);
    if (existing) {
      if (existing.revision === index.revision) return existing;
      this.unregister(owner);
    }

    const charts = this.chartSlots.allocate(owner, index.charts.length);
    let tiles: ChartAllocation;
    try {
      tiles = this.tileSlots.allocate(owner, Math.max(1, index.tiles.length));
    } catch (error) {
      this.chartSlots.release(owner);
      throw error;
    }

    const generation = ++this.generation;
    for (let localChart = 0; localChart < index.charts.length; localChart++) {
      this.chartGeneration[charts.base + localChart] = generation;
    }

    for (let localTile = 0; localTile < index.tiles.length; localTile++) {
      const record = index.tiles[localTile];
      const slot = tiles.base + localTile;
      this.tileGeneration[slot] = generation;
      this.tileChart[slot] = charts.base + record.chart;
      this.tileParent[slot] = record.parent === null ? -1 : tiles.base + record.parent;
      this.tileLevel[slot] = record.level;
      this.tileX[slot] = record.tileX;
      this.tileY[slot] = record.tileY;
    }

    const registered = { owner, revision: index.revision, generation, charts, tiles };
    this.chunks.set(owner, registered);
    return registered;
  }

  unregister(owner: string): boolean {
    const chunk = this.chunks.get(owner);
    if (!chunk) return false;
    this.chunks.delete(owner);

    this.chartGeneration.fill(0, chunk.charts.base, chunk.charts.base + chunk.charts.count);
    for (let slot = chunk.tiles.base; slot < chunk.tiles.base + chunk.tiles.count; slot++) {
      this.tileGeneration[slot] = 0;
      this.tileChart[slot] = -1;
      this.tileParent[slot] = -1;
      this.tileLevel[slot] = 0;
      this.tileX[slot] = 0;
      this.tileY[slot] = 0;
    }

    this.chartSlots.release(owner);
    this.tileSlots.release(owner);
    return true;
  }

  get(owner: string): RegisteredChunkLightmap | undefined {
    return this.chunks.get(owner);
  }

  globalChart(owner: string, localChart: number): number {
    const chunk = this.require(owner);
    if (localChart < 0 || localChart >= chunk.charts.count) throw new Error(`local chart ${localChart} is outside ${owner}`);
    return chunk.charts.base + localChart;
  }

  tileHandle(owner: string, localTile: number): WorldTileHandle {
    const chunk = this.require(owner);
    if (localTile < 0 || localTile >= chunk.tiles.count) throw new Error(`local tile ${localTile} is outside ${owner}`);
    return { slot: chunk.tiles.base + localTile, generation: chunk.generation };
  }

  isCurrent(handle: WorldTileHandle): boolean {
    return handle.slot >= 0 && handle.slot < this.tileGeneration.length && this.tileGeneration[handle.slot] === handle.generation;
  }

  snapshot(): {
    chunks: number;
    chartsUsed: number;
    chartCapacity: number;
    tilesUsed: number;
    tileCapacity: number;
    generation: number;
  } {
    return {
      chunks: this.chunks.size,
      chartsUsed: this.chartSlots.used,
      chartCapacity: this.chartCapacity,
      tilesUsed: this.tileSlots.used,
      tileCapacity: this.tileCapacity,
      generation: this.generation,
    };
  }

  private require(owner: string): RegisteredChunkLightmap {
    const chunk = this.chunks.get(owner);
    if (!chunk) throw new Error(`chunk lightmap ${owner} is not registered`);
    return chunk;
  }

  private validate(index: ChunkLightmapIndex): void {
    for (const [chart, record] of index.charts.entries()) {
      if (!Number.isInteger(record.tailLevel) || record.tailLevel < 0) throw new Error(`chart ${chart} has invalid tailLevel`);
      if (!Number.isInteger(record.tileStart) || record.tileStart < 0) throw new Error(`chart ${chart} has invalid tileStart`);
      if (!Number.isInteger(record.tileCount) || record.tileCount < 0) throw new Error(`chart ${chart} has invalid tileCount`);
      if (record.tileStart + record.tileCount > index.tiles.length) throw new Error(`chart ${chart} tile range exceeds tile index`);
    }

    for (const [tile, record] of index.tiles.entries()) {
      if (!Number.isInteger(record.chart) || record.chart < 0 || record.chart >= index.charts.length) throw new Error(`tile ${tile} has invalid chart`);
      if (!Number.isInteger(record.level) || record.level < 0 || record.level > 255) throw new Error(`tile ${tile} has invalid level`);
      if (!Number.isInteger(record.tileX) || record.tileX < 0 || record.tileX > 65535) throw new Error(`tile ${tile} has invalid tileX`);
      if (!Number.isInteger(record.tileY) || record.tileY < 0 || record.tileY > 65535) throw new Error(`tile ${tile} has invalid tileY`);
      if (record.parent !== null && (!Number.isInteger(record.parent) || record.parent < 0 || record.parent >= index.tiles.length)) throw new Error(`tile ${tile} has invalid parent`);
    }
  }
}
