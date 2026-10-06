import * as THREE from 'three/webgpu';
import { applyMobility, Mobility } from './mobility.ts';
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
  materialsChanged?: boolean;
  dispose?: () => void | Promise<void>;
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
  package: StreamedChunkPackage;
  tier: ChunkTier;
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
  ) {
    this.streamer = new CameraChunkStreamer<ResidentChunk>({
      load: async (coord, tier, signal) => {
        const packageValue = await this.provider.load(coord, signal);
        if (signal.aborted) {
          await packageValue.dispose?.();
          return { package: packageValue, tier };
        }
        this.prepare(packageValue);
        this.attach(packageValue, tier);
        return { package: packageValue, tier };
      },
      unload: async (resident) => {
        this.detach(resident.package, resident.tier);
        await resident.package.dispose?.();
      },
      setTier: (resident, tier) => {
        if (resident.tier === tier) return;
        this.applyTier(resident.package, tier);
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
      object.userData.giExclude = false;
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

  private attach(packageValue: StreamedChunkPackage, tier: ChunkTier): void {
    this.scene.add(packageValue.activeRoot);
    if (packageValue.proxyRoot) this.scene.add(packageValue.proxyRoot);
    this.applyTier(packageValue, tier);
    this.materialsChanged ||= packageValue.materialsChanged !== false;
  }

  private detach(packageValue: StreamedChunkPackage, tier: ChunkTier): void {
    if (tier === 'active') this.markDynamicChange();
    this.scene.remove(packageValue.activeRoot);
    if (packageValue.proxyRoot) this.scene.remove(packageValue.proxyRoot);
    this.materialsChanged ||= packageValue.materialsChanged !== false;
  }

  private applyTier(packageValue: StreamedChunkPackage, tier: ChunkTier): void {
    const activeVisible = tier === 'active';
    if (packageValue.activeRoot.visible !== activeVisible) {
      packageValue.activeRoot.visible = activeVisible;
      this.markDynamicChange();
    }
    if (packageValue.proxyRoot) packageValue.proxyRoot.visible = !activeVisible;
  }

  private markDynamicChange(): void {
    this.dynamicMembershipChanged = true;
    this.revision++;
  }
}
