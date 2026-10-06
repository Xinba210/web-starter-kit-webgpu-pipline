import type * as THREE from 'three/webgpu';
import type { StreamedChunkLightingSpec } from '../../world/assetManifest.ts';
import type { StreamedChunkLightingController } from '../../world/streamedScene.ts';
import { ChartNamespace, remapLightmapCharts, type ChartAllocation } from './chartNamespace.ts';

export interface ActiveChunkLighting {
  owner: string;
  spec: StreamedChunkLightingSpec;
  allocation: ChartAllocation;
  remappedGeometries: number;
}

export class ChunkLightingRuntime implements StreamedChunkLightingController {
  readonly charts: ChartNamespace;
  private readonly active = new Map<string, ActiveChunkLighting>();

  constructor(chartCapacity = 65536) {
    this.charts = new ChartNamespace(chartCapacity);
  }

  activate(owner: string, root: THREE.Object3D, spec: StreamedChunkLightingSpec): void {
    const current = this.active.get(owner);
    if (current) {
      if (
        current.spec.revision === spec.revision &&
        current.spec.chartCount === spec.chartCount &&
        current.spec.packageUrl === spec.packageUrl
      ) return;
      this.deactivate(owner);
    }

    const allocation = this.charts.allocate(owner, spec.chartCount);
    const remappedGeometries = remapLightmapCharts(root, allocation);
    this.active.set(owner, { owner, spec, allocation, remappedGeometries });
  }

  deactivate(owner: string): void {
    if (!this.active.delete(owner)) return;
    this.charts.release(owner);
  }

  get(owner: string): ActiveChunkLighting | undefined {
    return this.active.get(owner);
  }

  snapshot(): {
    chartCapacity: number;
    chartsUsed: number;
    chartsFree: number;
    activeChunks: number;
    chunks: Array<{
      owner: string;
      base: number;
      charts: number;
      generation: number;
      revision: string;
      packageUrl: string;
      remappedGeometries: number;
    }>;
  } {
    const chartState = this.charts.snapshot();
    return {
      chartCapacity: chartState.capacity,
      chartsUsed: chartState.used,
      chartsFree: chartState.free,
      activeChunks: this.active.size,
      chunks: [...this.active.values()]
        .sort((a, b) => a.allocation.base - b.allocation.base)
        .map((chunk) => ({
          owner: chunk.owner,
          base: chunk.allocation.base,
          charts: chunk.allocation.count,
          generation: chunk.allocation.generation,
          revision: chunk.spec.revision,
          packageUrl: chunk.spec.packageUrl,
          remappedGeometries: chunk.remappedGeometries,
        })),
    };
  }
}
