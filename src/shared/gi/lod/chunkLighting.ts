import type * as THREE from 'three/webgpu';
import type { StreamedChunkLightingSpec } from '../../world/assetManifest.ts';
import type { StreamedChunkLightingController } from '../../world/streamedScene.ts';
import { remapLightmapCharts } from './chartNamespace.ts';
import {
  loadChunkLightmapPackage,
  type DecodedChunkLightmapPackage,
} from './chunkLightmapPackage.ts';
import {
  WorldLightmapRegistry,
  type RegisteredChunkLightmap,
} from './worldLightmapRegistry.ts';

type ChunkPackageLoader = (
  url: string,
  signal?: AbortSignal,
) => Promise<DecodedChunkLightmapPackage>;

export interface ActiveChunkLighting {
  owner: string;
  spec: StreamedChunkLightingSpec;
  state: 'loading' | 'ready' | 'failed';
  remappedGeometries: number;
  registered?: RegisteredChunkLightmap;
  package?: DecodedChunkLightmapPackage;
  error?: string;
}

type InternalChunkLighting = ActiveChunkLighting & {
  root: THREE.Object3D;
  controller: AbortController;
  request: number;
};

export class ChunkLightingRuntime implements StreamedChunkLightingController {
  readonly registry: WorldLightmapRegistry;
  private readonly active = new Map<string, InternalChunkLighting>();
  private request = 0;
  private packageTileSize: number | null = null;
  private packageBorder: number | null = null;

  constructor(
    chartCapacity = 65536,
    tileCapacity = 262144,
    private readonly loadPackage: ChunkPackageLoader = loadChunkLightmapPackage,
  ) {
    this.registry = new WorldLightmapRegistry(chartCapacity, tileCapacity);
  }

  activate(owner: string, root: THREE.Object3D, spec: StreamedChunkLightingSpec): void {
    const current = this.active.get(owner);
    if (current) {
      if (
        current.root === root &&
        current.spec.revision === spec.revision &&
        current.spec.chartCount === spec.chartCount &&
        current.spec.packageUrl === spec.packageUrl
      ) return;
      this.deactivate(owner);
    }

    const entry: InternalChunkLighting = {
      owner,
      root,
      spec,
      state: 'loading',
      remappedGeometries: 0,
      controller: new AbortController(),
      request: ++this.request,
    };
    this.active.set(owner, entry);
    void this.loadAndRegister(entry);
  }

  deactivate(owner: string): void {
    const entry = this.active.get(owner);
    if (!entry) return;
    this.active.delete(owner);
    entry.controller.abort();
    if (entry.registered) this.registry.unregister(owner);
  }

  get(owner: string): ActiveChunkLighting | undefined {
    return this.active.get(owner);
  }

  snapshot(): {
    chartCapacity: number;
    chartsUsed: number;
    tileCapacity: number;
    tilesUsed: number;
    activeChunks: number;
    loadingChunks: number;
    readyChunks: number;
    failedChunks: number;
    packageTileSize: number | null;
    packageBorder: number | null;
    chunks: Array<{
      owner: string;
      state: string;
      base: number | null;
      charts: number;
      tiles: number;
      generation: number | null;
      revision: string;
      packageUrl: string;
      storeKiB: number;
      remappedGeometries: number;
      error: string | null;
    }>;
  } {
    const registry = this.registry.snapshot();
    const entries = [...this.active.values()];
    return {
      chartCapacity: registry.chartCapacity,
      chartsUsed: registry.chartsUsed,
      tileCapacity: registry.tileCapacity,
      tilesUsed: registry.tilesUsed,
      activeChunks: entries.length,
      loadingChunks: entries.filter((entry) => entry.state === 'loading').length,
      readyChunks: entries.filter((entry) => entry.state === 'ready').length,
      failedChunks: entries.filter((entry) => entry.state === 'failed').length,
      packageTileSize: this.packageTileSize,
      packageBorder: this.packageBorder,
      chunks: entries
        .sort((a, b) => (a.registered?.charts.base ?? Number.MAX_SAFE_INTEGER) - (b.registered?.charts.base ?? Number.MAX_SAFE_INTEGER))
        .map((entry) => ({
          owner: entry.owner,
          state: entry.state,
          base: entry.registered?.charts.base ?? null,
          charts: entry.spec.chartCount,
          tiles: entry.registered?.tileCount ?? 0,
          generation: entry.registered?.generation ?? null,
          revision: entry.spec.revision,
          packageUrl: entry.spec.packageUrl,
          storeKiB: +((entry.package?.storeBytes ?? 0) / 1024).toFixed(1),
          remappedGeometries: entry.remappedGeometries,
          error: entry.error ?? null,
        })),
    };
  }

  private async loadAndRegister(entry: InternalChunkLighting): Promise<void> {
    try {
      const packageValue = await this.loadPackage(entry.spec.packageUrl, entry.controller.signal);
      if (!this.isCurrent(entry)) return;
      this.validatePackage(entry.spec, packageValue);
      const registered = this.registry.register(entry.owner, packageValue.index);
      if (!this.isCurrent(entry)) {
        this.registry.unregister(entry.owner);
        return;
      }
      entry.registered = registered;
      entry.remappedGeometries = remapLightmapCharts(entry.root, registered.charts);
      entry.package = packageValue;
      this.packageTileSize ??= packageValue.tileSize;
      this.packageBorder ??= packageValue.border;
      entry.state = 'ready';
    } catch (error) {
      if (!this.isCurrent(entry) || entry.controller.signal.aborted) return;
      if (entry.registered) {
        this.registry.unregister(entry.owner);
        entry.registered = undefined;
      }
      entry.state = 'failed';
      entry.error = String(error);
    }
  }

  private isCurrent(entry: InternalChunkLighting): boolean {
    return this.active.get(entry.owner)?.request === entry.request;
  }

  private validatePackage(spec: StreamedChunkLightingSpec, packageValue: DecodedChunkLightmapPackage): void {
    if (packageValue.revision !== spec.revision) {
      throw new Error(`chunk lighting revision mismatch: manifest ${spec.revision}, package ${packageValue.revision}`);
    }
    if (packageValue.index.charts.length !== spec.chartCount) {
      throw new Error(`chunk lighting chart count mismatch: manifest ${spec.chartCount}, package ${packageValue.index.charts.length}`);
    }
    if (Math.abs(packageValue.metresPerTexel - spec.metresPerTexel) > 1e-6) {
      throw new Error(`chunk lighting density mismatch: manifest ${spec.metresPerTexel}, package ${packageValue.metresPerTexel}`);
    }
    if (this.packageTileSize !== null && this.packageTileSize !== packageValue.tileSize) {
      throw new Error(`chunk lighting tile size mismatch: expected ${this.packageTileSize}, got ${packageValue.tileSize}`);
    }
    if (this.packageBorder !== null && this.packageBorder !== packageValue.border) {
      throw new Error(`chunk lighting border mismatch: expected ${this.packageBorder}, got ${packageValue.border}`);
    }
  }
}
