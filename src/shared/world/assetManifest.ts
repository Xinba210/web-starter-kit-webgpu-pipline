import { chunkId, type ChunkCoordinate } from './chunkStreamer.ts';

export type AssetClearance = 'xinba-owned' | 'cleared-commercial' | 'prototype-only';

export interface StreamedAssetProvenance {
  clearance: AssetClearance;
  source: string;
  licenseRef?: string;
}

export interface StreamedAssetTransform {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

export interface StreamedAssetSpec {
  id: string;
  activeGlb: string;
  proxyGlb?: string;
  transform?: StreamedAssetTransform;
  provenance: StreamedAssetProvenance;
}

export interface StreamedChunkLightingSpec {
  packageUrl: string;
  chartCount: number;
  revision: string;
  metresPerTexel: number;
}

export interface StreamedChunkSpec {
  coord: ChunkCoordinate;
  assets: StreamedAssetSpec[];
  lighting?: StreamedChunkLightingSpec;
}

export interface StreamedAssetManifest {
  version: 1;
  chunks: StreamedChunkSpec[];
}

export interface ManifestValidationOptions {
  allowPrototypeAssets?: boolean;
}

export function validateStreamedAssetManifest(
  manifest: StreamedAssetManifest,
  options: ManifestValidationOptions = {},
): void {
  if (manifest.version !== 1) throw new Error(`unsupported streamed asset manifest version ${manifest.version}`);

  const chunkIds = new Set<string>();
  const assetIds = new Set<string>();

  for (const chunk of manifest.chunks) {
    const id = chunkId(chunk.coord.x, chunk.coord.z);
    if (chunkIds.has(id)) throw new Error(`duplicate streamed chunk ${id}`);
    chunkIds.add(id);

    if (chunk.lighting) {
      if (!chunk.lighting.packageUrl.trim()) throw new Error(`streamed chunk ${id} lighting has no packageUrl`);
      if (!Number.isInteger(chunk.lighting.chartCount) || chunk.lighting.chartCount < 1) throw new Error(`streamed chunk ${id} lighting chartCount must be a positive integer`);
      if (!chunk.lighting.revision.trim()) throw new Error(`streamed chunk ${id} lighting has no revision`);
      if (!Number.isFinite(chunk.lighting.metresPerTexel) || chunk.lighting.metresPerTexel <= 0) throw new Error(`streamed chunk ${id} lighting metresPerTexel must be positive`);
    }

    for (const asset of chunk.assets) {
      if (!asset.id.trim()) throw new Error(`streamed asset in chunk ${id} has no id`);
      if (assetIds.has(asset.id)) throw new Error(`duplicate streamed asset id ${asset.id}`);
      assetIds.add(asset.id);
      if (!asset.activeGlb.trim()) throw new Error(`streamed asset ${asset.id} has no activeGlb`);
      if (!asset.provenance.source.trim()) throw new Error(`streamed asset ${asset.id} has no provenance source`);
      if (asset.provenance.clearance === 'prototype-only' && !options.allowPrototypeAssets) {
        throw new Error(`streamed asset ${asset.id} is prototype-only and cannot enter a cleared build`);
      }
      if (asset.provenance.clearance === 'cleared-commercial' && !asset.provenance.licenseRef?.trim()) {
        throw new Error(`streamed asset ${asset.id} needs a commercial license reference`);
      }
    }
  }
}

export function indexStreamedAssetManifest(
  manifest: StreamedAssetManifest,
  options: ManifestValidationOptions = {},
): Map<string, StreamedChunkSpec> {
  validateStreamedAssetManifest(manifest, options);
  return new Map(manifest.chunks.map((chunk) => [chunkId(chunk.coord.x, chunk.coord.z), chunk]));
}
