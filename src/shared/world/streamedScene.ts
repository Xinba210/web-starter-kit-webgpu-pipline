import * as THREE from 'three/webgpu';
import { applyMobility, Mobility } from './mobility.ts';
import type { StreamedChunkLightingSpec } from './assetManifest.ts';
import {
  CameraChunkStreamer,
  type ChunkCameraSample,
  type ChunkCoordinate,
  type ChunkStreamerSettings,
  type ChunkStreamingSnapshot,
  type ChunkTier,
} from './chunkStreamer.ts';

export interface StreamedChunkPackage {
  activeRoot: THREE.Object3D;
  proxyRoot?: THREE.Object3D;
  lighting?: StreamedChunkLightingSpec;
  materialsChanged?: boolean;
  dispose?: () => void | Promise<void>;
}

export interface StreamedChunkLightingController {
  activate(owner: string, root: THREE.Object3D, spec: StreamedChunkLightingSpec): void;
  deactivate(owner: string): void;
  snapshot?(): unknown;
}

export interface StreamedChunkProvider {
  load(coord: ChunkCoordinate, signal: AbortSignal): StreamedChunkPackage | Promise<StreamedChunkPackage>;
}

export interface StreamedSceneChanges {
  dynamicMembershipChanged: boolean;
  materialsChanged: boolean;
  revision: number;
}

type ResidentChunk = {
  owner: string;
  package: StreamedChunkPackage;
  tier: ChunkTier;
  attached: boolean;
};

export class StreamedSceneRuntime {
  readonly streamer: CameraChunkStreamer<ResidentChunk>;
  private dynamicMembershipChanged = false;
  private materialsChanged = false;
  private revision = 0;
  private syncCount = 0;
  private readonly forward = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly provider: StreamedChunkProvider,
    settings: Partial<ChunkStreamerSettings> = {},
    private readonly lighting?: StreamedChunkLightingController,
  ) {
    this.streamer = new CameraChunkStreamer<ResidentChunk>({
      load: async (coord, tier, signal) => {
        const owner = `${coord.x}:${coord.z}`;
        const packageValue = await this.provider.load(coord, signal);
        if (signal.aborted) return { owner, package: packageValue, tier, attached: false };
        this.prepare(packageValue);
        this.attach(owner, packageValue, tier);
        return { owner, package: packageValue, tier, attached: true };
      },
      unload: async (resident) => {
        if (resident.attached) this.detach(resident.owner, resident.package, resident.tier);
        await resident.package.dispose?.();
      },
      setTier: (resident, tier) => {
        if (resident.tier === tier) return;
        if (resident.attached) this.applyTier(resident.owner, resident.package, tier);
        resident.tier = tier;
      },
    }, settings);
  }

  update(camera: THREE.PerspectiveCamera): ChunkStreamingSnapshot {
    camera.getWorldDirection(this.forward);
    return this.updateSample({
      x: camera.position.x,
      z: camera.position.z,
      forwardX: this.forward.x,
      forwardZ: this.forward.z,
    });
  }

  updateSample(sample: ChunkCameraSample): ChunkStreamingSnapshot {
    return this.streamer.update(sample);
  }

  consumeChanges(): StreamedSceneChanges {
    const changes = {
      dynamicMembershipChanged: this.dynamicMembershipChanged,
      materialsChanged: this.materialsChanged,
      revision: this.revision,
    };
    if (changes.dynamicMembershipChanged) this.syncCount++;
    this.dynamicMembershipChanged = false;
    this.materialsChanged = false;
    return changes;
  }

  snapshot(): ChunkStreamingSnapshot & { revision: number; dynamicSyncCount: number } {
    return {
      ...this.streamer.snapshot(),
      revision: this.revision,
      dynamicSyncCount: this.syncCount,
      lighting: this.lighting?.snapshot?.() ?? null,
    };
  }

  residentIds(): string[] {
    return this.streamer.residentIds();
  }

  dispose(): void {
    this.streamer.dispose();
  }

  private prepare(packageValue: StreamedChunkPackage): void {
    applyMobility(packageValue.activeRoot, Mobility.Movable, { contributesToStaticGi: false });
    packageValue.activeRoot.traverse((object) => {
      object.userData.streamedChunkRole = 'active';
      if (object.userData.giExclude === undefined) object.userData.giExclude = false;
    });

    if (packageValue.proxyRoot) {
      applyMobility(packageValue.proxyRoot, Mobility.Movable, {
        castShadow: false,
        contributesToStaticGi: false,
      });
      packageValue.proxyRoot.traverse((object) => {
        object.userData.streamedChunkRole = 'proxy';
        object.userData.giExclude = true;
      });
    }
  }

  private attach(owner: string, packageValue: StreamedChunkPackage, tier: ChunkTier): void {
    const active = tier === 'active';
    packageValue.activeRoot.visible = active;
    if (packageValue.proxyRoot) packageValue.proxyRoot.visible = !active;
    this.scene.add(packageValue.activeRoot);
    if (packageValue.proxyRoot) this.scene.add(packageValue.proxyRoot);
    if (active) {
      if (packageValue.lighting) this.lighting?.activate(owner, packageValue.activeRoot, packageValue.lighting);
      this.markDynamicChange();
      this.materialsChanged ||= packageValue.materialsChanged !== false;
    }
  }

  private detach(owner: string, packageValue: StreamedChunkPackage, tier: ChunkTier): void {
    if (tier === 'active') {
      if (packageValue.lighting) this.lighting?.deactivate(owner);
      this.markDynamicChange();
      this.materialsChanged ||= packageValue.materialsChanged !== false;
    }
    this.scene.remove(packageValue.activeRoot);
    if (packageValue.proxyRoot) this.scene.remove(packageValue.proxyRoot);
  }

  private applyTier(owner: string, packageValue: StreamedChunkPackage, tier: ChunkTier): void {
    const activeVisible = tier === 'active';
    if (packageValue.activeRoot.visible !== activeVisible) {
      if (packageValue.lighting) {
        if (activeVisible) this.lighting?.activate(owner, packageValue.activeRoot, packageValue.lighting);
        else this.lighting?.deactivate(owner);
      }
      packageValue.activeRoot.visible = activeVisible;
      this.markDynamicChange();
      this.materialsChanged ||= packageValue.materialsChanged !== false;
    }
    if (packageValue.proxyRoot) packageValue.proxyRoot.visible = !activeVisible;
  }

  private markDynamicChange(): void {
    this.dynamicMembershipChanged = true;
    this.revision++;
  }
}
