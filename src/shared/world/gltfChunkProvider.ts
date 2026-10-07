import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  indexStreamedAssetManifest,
  type ManifestValidationOptions,
  type StreamedAssetManifest,
  type StreamedAssetSpec,
  type StreamedAssetTransform,
} from './assetManifest.ts';
import { chunkId, type ChunkCoordinate } from './chunkStreamer.ts';
import type { StreamedChunkPackage, StreamedChunkProvider } from './streamedScene.ts';

export interface GltfChunkProviderOptions extends ManifestValidationOptions {
  baseUrl?: string;
}

function runtimeBaseUrl(explicit?: string): string {
  const page = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  return explicit ? new URL(explicit, page).href : page;
}

function applyTransform(root: THREE.Object3D, transform?: StreamedAssetTransform): void {
  if (!transform) return;
  if (transform.position) root.position.fromArray(transform.position);
  if (transform.rotation) root.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2]);
  if (transform.scale) root.scale.fromArray(transform.scale);
  root.updateMatrixWorld(true);
}

function collectResources(root: THREE.Object3D): {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
} {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        const candidate = value as { isTexture?: boolean };
        if (candidate?.isTexture) textures.add(value as THREE.Texture);
      }
    }
  });
  return { geometries, materials, textures };
}

function disposeResources(root: THREE.Object3D): void {
  const { geometries, materials, textures } = collectResources(root);
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

async function loadGlb(loader: GLTFLoader, url: string, baseUrl: string, signal: AbortSignal): Promise<THREE.Group> {
  const absoluteUrl = new URL(url, baseUrl).href;
  const response = await fetch(absoluteUrl, { signal });
  if (!response.ok) throw new Error(`failed to load streamed GLB ${absoluteUrl}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const gltf = await loader.parseAsync(bytes, new URL('.', absoluteUrl).href);
  return gltf.scene;
}

function promotePbrNodeMaterials(root: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.Material>();

  const convert = (material: THREE.Material): THREE.Material => {
    const cached = converted.get(material);
    if (cached) return cached;
    const pbr = material as THREE.MeshStandardMaterial & { isMeshPhysicalMaterial?: boolean; isNodeMaterial?: boolean };
    if (!pbr.isMeshStandardMaterial || pbr.isNodeMaterial) {
      converted.set(material, material);
      return material;
    }

    const node = pbr.isMeshPhysicalMaterial
      ? new THREE.MeshPhysicalNodeMaterial()
      : new THREE.MeshStandardNodeMaterial();
    node.copy(pbr as never);
    node.name = material.name;
    node.userData = { ...material.userData, streamedNodeMaterial: true };
    converted.set(material, node);
    material.dispose();
    return node;
  };

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material);
  });
}

function prepareChunkLightmapAttributes(root: THREE.Object3D, chartCount: number): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const uv1 = mesh.geometry.getAttribute('uv1');
    if (!uv1) throw new Error(`streamed lightmapped mesh ${mesh.name || mesh.uuid} has no uv1 attribute`);
    if (mesh.geometry.getAttribute('lightmapChart')) return;
    if (chartCount !== 1) {
      throw new Error(`streamed lightmapped mesh ${mesh.name || mesh.uuid} must provide lightmapChart for ${chartCount} charts`);
    }
    mesh.geometry.setAttribute('lightmapChart', new THREE.Float32BufferAttribute(new Float32Array(uv1.count), 1));
  });
}

function nameRoot(root: THREE.Object3D, asset: StreamedAssetSpec, tier: 'active' | 'proxy'): void {
  root.name = `streamed-${tier}-${asset.id}`;
  root.userData.assetId = asset.id;
  root.userData.assetClearance = asset.provenance.clearance;
  root.userData.assetSource = asset.provenance.source;
  if (asset.provenance.licenseRef) root.userData.assetLicenseRef = asset.provenance.licenseRef;
}

export function createGltfChunkProvider(
  manifest: StreamedAssetManifest,
  options: GltfChunkProviderOptions = {},
): StreamedChunkProvider {
  const indexed = indexStreamedAssetManifest(manifest, options);
  const loader = new GLTFLoader();
  const baseUrl = runtimeBaseUrl(options.baseUrl);

  return {
    async load(coord: ChunkCoordinate, signal: AbortSignal): Promise<StreamedChunkPackage> {
      const activeRoot = new THREE.Group();
      activeRoot.name = `streamed-active-chunk-${chunkId(coord.x, coord.z)}`;
      const proxyRoot = new THREE.Group();
      proxyRoot.name = `streamed-proxy-chunk-${chunkId(coord.x, coord.z)}`;
      const chunk = indexed.get(chunkId(coord.x, coord.z));

      try {
        for (const asset of chunk?.assets ?? []) {
          const active = await loadGlb(loader, asset.activeGlb, baseUrl, signal);
          nameRoot(active, asset, 'active');
          applyTransform(active, asset.transform);
          promotePbrNodeMaterials(active);
          if (chunk?.lighting) prepareChunkLightmapAttributes(active, chunk.lighting.chartCount);
          activeRoot.add(active);

          if (asset.proxyGlb) {
            const proxy = await loadGlb(loader, asset.proxyGlb, baseUrl, signal);
            nameRoot(proxy, asset, 'proxy');
            applyTransform(proxy, asset.transform);
            proxyRoot.add(proxy);
          }
        }
      } catch (error) {
        disposeResources(activeRoot);
        disposeResources(proxyRoot);
        throw error;
      }

      const hasProxy = proxyRoot.children.length > 0;
      return {
        activeRoot,
        proxyRoot: hasProxy ? proxyRoot : undefined,
        lighting: chunk?.lighting,
        materialsChanged: activeRoot.children.length > 0,
        dispose() {
          disposeResources(activeRoot);
          if (hasProxy) disposeResources(proxyRoot);
        },
      };
    },
  };
}
