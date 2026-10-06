import * as THREE from 'three/webgpu';

export interface ChartAllocation {
  owner: string;
  base: number;
  count: number;
  generation: number;
}

type FreeRange = {
  base: number;
  count: number;
};

export class ChartNamespace {
  private readonly allocations = new Map<string, ChartAllocation>();
  private free: FreeRange[];
  private generation = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('chart namespace capacity must be a positive integer');
    this.free = [{ base: 0, count: capacity }];
  }

  allocate(owner: string, count: number): ChartAllocation {
    if (!owner.trim()) throw new Error('chart namespace owner is required');
    if (!Number.isInteger(count) || count < 1) throw new Error('chart allocation count must be a positive integer');
    const existing = this.allocations.get(owner);
    if (existing) {
      if (existing.count !== count) throw new Error(`chart owner ${owner} already holds ${existing.count} slots, not ${count}`);
      return existing;
    }

    const index = this.free.findIndex((range) => range.count >= count);
    if (index < 0) throw new Error(`chart namespace exhausted: need ${count}, free ${this.freeCount}`);
    const range = this.free[index];
    const allocation = { owner, base: range.base, count, generation: ++this.generation };
    this.allocations.set(owner, allocation);

    if (range.count === count) this.free.splice(index, 1);
    else {
      range.base += count;
      range.count -= count;
    }
    return allocation;
  }

  release(owner: string): boolean {
    const allocation = this.allocations.get(owner);
    if (!allocation) return false;
    this.allocations.delete(owner);
    this.free.push({ base: allocation.base, count: allocation.count });
    this.coalesce();
    return true;
  }

  get(owner: string): ChartAllocation | undefined {
    return this.allocations.get(owner);
  }

  get used(): number {
    let count = 0;
    for (const allocation of this.allocations.values()) count += allocation.count;
    return count;
  }

  get freeCount(): number {
    return this.capacity - this.used;
  }

  snapshot(): { capacity: number; used: number; free: number; allocations: ChartAllocation[] } {
    return {
      capacity: this.capacity,
      used: this.used,
      free: this.freeCount,
      allocations: [...this.allocations.values()].sort((a, b) => a.base - b.base),
    };
  }

  private coalesce(): void {
    this.free.sort((a, b) => a.base - b.base);
    const merged: FreeRange[] = [];
    for (const range of this.free) {
      const previous = merged[merged.length - 1];
      if (previous && previous.base + previous.count === range.base) previous.count += range.count;
      else merged.push({ ...range });
    }
    this.free = merged;
  }
}

export function remapLightmapCharts(root: THREE.Object3D, allocation: ChartAllocation): number {
  const seen = new Set<THREE.BufferGeometry>();
  let remapped = 0;

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || seen.has(mesh.geometry)) return;
    const attribute = mesh.geometry.getAttribute('lightmapChart');
    if (!attribute) return;
    if (attribute.itemSize !== 1) throw new Error(`lightmapChart on ${mesh.name || mesh.uuid} must have itemSize 1`);

    const values = new Float32Array(attribute.count);
    for (let index = 0; index < attribute.count; index++) {
      const local = Math.round(attribute.getX(index));
      if (local < 0 || local >= allocation.count) {
        throw new Error(`lightmapChart ${local} on ${mesh.name || mesh.uuid} exceeds chunk chart count ${allocation.count}`);
      }
      values[index] = allocation.base + local;
    }
    mesh.geometry.setAttribute('lightmapChart', new THREE.BufferAttribute(values, 1));
    mesh.geometry.userData.chunkLightmapOwner = allocation.owner;
    mesh.geometry.userData.chunkLightmapBase = allocation.base;
    seen.add(mesh.geometry);
    remapped++;
  });

  return remapped;
}
