export type ChunkTier = 'active' | 'prefetch';

export interface ChunkCoordinate {
  x: number;
  z: number;
}

export interface ChunkCameraSample {
  x: number;
  z: number;
  forwardX: number;
  forwardZ: number;
}

export interface ChunkStreamerSettings {
  cellSize: number;
  activeRadius: number;
  prefetchRadius: number;
  unloadRadius: number;
  lookAheadCells: number;
  maxLoadsPerUpdate: number;
  maxUnloadsPerUpdate: number;
}

export interface ChunkDemand extends ChunkCoordinate {
  id: string;
  tier: ChunkTier;
  priority: number;
}

export interface ChunkLifecycle<T> {
  load(coord: ChunkCoordinate, tier: ChunkTier, signal: AbortSignal): T | Promise<T>;
  unload(value: T, coord: ChunkCoordinate): void | Promise<void>;
  setTier?(value: T, tier: ChunkTier, coord: ChunkCoordinate): void | Promise<void>;
}

export interface ChunkStreamingSnapshot {
  frame: number;
  desired: number;
  resident: number;
  loading: number;
  active: number;
  prefetch: number;
  loadsStarted: number;
  unloadsStarted: number;
  cancelledLoads: number;
}

type ChunkRecord<T> = {
  coord: ChunkCoordinate;
  tier: ChunkTier;
  state: 'loading' | 'resident';
  token: number;
  controller: AbortController;
  value?: T;
};

const DEFAULT_SETTINGS: ChunkStreamerSettings = {
  cellSize: 32,
  activeRadius: 1.25,
  prefetchRadius: 2.75,
  unloadRadius: 4,
  lookAheadCells: 1.5,
  maxLoadsPerUpdate: 4,
  maxUnloadsPerUpdate: 4,
};

export function chunkId(x: number, z: number): string {
  return `${x}:${z}`;
}

function cellAt(world: number, cellSize: number): number {
  return Math.floor(world / cellSize);
}

function normalizedForward(sample: ChunkCameraSample): [number, number] {
  const length = Math.hypot(sample.forwardX, sample.forwardZ);
  return length > 1e-6 ? [sample.forwardX / length, sample.forwardZ / length] : [0, 0];
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

export class CameraChunkStreamer<T> {
  private readonly settings: ChunkStreamerSettings;
  private readonly records = new Map<string, ChunkRecord<T>>();
  private frame = 0;
  private token = 0;
  private lastSnapshot: ChunkStreamingSnapshot = {
    frame: 0,
    desired: 0,
    resident: 0,
    loading: 0,
    active: 0,
    prefetch: 0,
    loadsStarted: 0,
    unloadsStarted: 0,
    cancelledLoads: 0,
  };

  constructor(private readonly lifecycle: ChunkLifecycle<T>, settings: Partial<ChunkStreamerSettings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    if (this.settings.cellSize <= 0) throw new Error('chunk cellSize must be positive');
    if (this.settings.activeRadius < 0 || this.settings.prefetchRadius < this.settings.activeRadius) throw new Error('chunk radii are invalid');
    if (this.settings.unloadRadius < this.settings.prefetchRadius) throw new Error('chunk unloadRadius must cover prefetchRadius');
  }

  plan(sample: ChunkCameraSample): ChunkDemand[] {
    const cameraX = cellAt(sample.x, this.settings.cellSize);
    const cameraZ = cellAt(sample.z, this.settings.cellSize);
    const [forwardX, forwardZ] = normalizedForward(sample);
    const lookX = cameraX + forwardX * this.settings.lookAheadCells;
    const lookZ = cameraZ + forwardZ * this.settings.lookAheadCells;
    const radius = Math.ceil(this.settings.prefetchRadius + this.settings.lookAheadCells + 1);
    const demands: ChunkDemand[] = [];

    for (let z = cameraZ - radius; z <= cameraZ + radius; z++) {
      for (let x = cameraX - radius; x <= cameraX + radius; x++) {
        const activeDistance = Math.hypot(x - cameraX, z - cameraZ);
        const prefetchDistance = Math.hypot(x - lookX, z - lookZ);
        const tier = activeDistance <= this.settings.activeRadius
          ? 'active'
          : prefetchDistance <= this.settings.prefetchRadius
            ? 'prefetch'
            : null;
        if (!tier) continue;
        const distance = tier === 'active' ? activeDistance : prefetchDistance;
        const priority = (tier === 'active' ? 1_000_000 : 0) - distance * 1_000 - Math.abs(x) - Math.abs(z) * 0.001;
        demands.push({ id: chunkId(x, z), x, z, tier, priority });
      }
    }

    demands.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    return demands;
  }

  update(sample: ChunkCameraSample): ChunkStreamingSnapshot {
    this.frame++;
    const demands = this.plan(sample);
    const desired = new Map(demands.map((demand) => [demand.id, demand]));
    let cancelledLoads = 0;
    let unloadsStarted = 0;
    let loadsStarted = 0;

    for (const [id, record] of this.records) {
      const demand = desired.get(id);
      if (demand) {
        if (record.tier !== demand.tier) {
          record.tier = demand.tier;
          if (record.state === 'resident' && record.value !== undefined) void this.lifecycle.setTier?.(record.value, demand.tier, record.coord);
        }
        continue;
      }
      if (record.state === 'loading') {
        record.controller.abort();
        this.records.delete(id);
        cancelledLoads++;
        continue;
      }
      if (unloadsStarted >= this.settings.maxUnloadsPerUpdate || !this.outsideUnloadRadius(record.coord, sample)) {
        if (record.tier !== 'prefetch') {
          record.tier = 'prefetch';
          if (record.value !== undefined) void this.lifecycle.setTier?.(record.value, 'prefetch', record.coord);
        }
        continue;
      }
      this.records.delete(id);
      if (record.value !== undefined) void this.lifecycle.unload(record.value, record.coord);
      unloadsStarted++;
    }

    for (const demand of demands) {
      if (loadsStarted >= this.settings.maxLoadsPerUpdate) break;
      if (this.records.has(demand.id)) continue;
      this.startLoad(demand);
      loadsStarted++;
    }

    this.lastSnapshot = this.measure(demands.length, loadsStarted, unloadsStarted, cancelledLoads);
    return this.lastSnapshot;
  }

  snapshot(): ChunkStreamingSnapshot {
    return this.lastSnapshot;
  }

  residentIds(): string[] {
    return [...this.records.entries()].filter(([, record]) => record.state === 'resident').map(([id]) => id).sort();
  }

  dispose(): void {
    for (const record of this.records.values()) {
      record.controller.abort();
      if (record.state === 'resident' && record.value !== undefined) void this.lifecycle.unload(record.value, record.coord);
    }
    this.records.clear();
  }

  private startLoad(demand: ChunkDemand): void {
    const controller = new AbortController();
    const token = ++this.token;
    const record: ChunkRecord<T> = {
      coord: { x: demand.x, z: demand.z },
      tier: demand.tier,
      state: 'loading',
      token,
      controller,
    };
    this.records.set(demand.id, record);
    const result = this.lifecycle.load(record.coord, record.tier, controller.signal);
    if (isPromiseLike(result)) {
      void result.then((value) => this.finishLoad(demand.id, token, value)).catch((error) => {
        const current = this.records.get(demand.id);
        if (current?.token === token) this.records.delete(demand.id);
        if (!controller.signal.aborted) console.error('[chunk-stream]', error);
      });
    } else {
      this.finishLoad(demand.id, token, result);
    }
  }

  private finishLoad(id: string, token: number, value: T): void {
    const record = this.records.get(id);
    if (!record || record.token !== token || record.controller.signal.aborted) {
      const [x, z] = id.split(':').map(Number);
      void this.lifecycle.unload(value, { x, z });
      return;
    }
    record.state = 'resident';
    record.value = value;
  }

  private outsideUnloadRadius(coord: ChunkCoordinate, sample: ChunkCameraSample): boolean {
    const cameraX = cellAt(sample.x, this.settings.cellSize);
    const cameraZ = cellAt(sample.z, this.settings.cellSize);
    return Math.hypot(coord.x - cameraX, coord.z - cameraZ) > this.settings.unloadRadius;
  }

  private measure(desired: number, loadsStarted: number, unloadsStarted: number, cancelledLoads: number): ChunkStreamingSnapshot {
    let resident = 0;
    let loading = 0;
    let active = 0;
    let prefetch = 0;
    for (const record of this.records.values()) {
      if (record.state === 'loading') loading++;
      else {
        resident++;
        if (record.tier === 'active') active++;
        else prefetch++;
      }
    }
    return { frame: this.frame, desired, resident, loading, active, prefetch, loadsStarted, unloadsStarted, cancelledLoads };
  }
}

export function chunkWorldOrigin(coord: ChunkCoordinate, cellSize: number): { x: number; z: number } {
  return {
    x: (coord.x + 0.5) * cellSize,
    z: (coord.z + 0.5) * cellSize,
  };
}
