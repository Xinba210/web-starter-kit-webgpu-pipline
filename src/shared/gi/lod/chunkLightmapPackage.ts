import type {
  ChunkChartIndexRecord,
  ChunkLightmapIndex,
  ChunkTileIndexRecord,
} from './worldLightmapRegistry.ts';
import { validateChunkLightmapIndex } from './worldLightmapRegistry.ts';

const XVLM_MAGIC = 0x4d4c5658;
const XVLM_VERSION = 1;
const XVLM_HEADER_BYTES = 16;
const XVLM_DIGEST_BYTES = 32;

interface XvlmTileRecord extends ChunkTileIndexRecord {
  byteOffset: number;
  byteLength: number;
}

export interface ChunkFallbackRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface XvlmMetadata {
  revision: string;
  metresPerTexel: number;
  tileSize: number;
  border: number;
  fallbackWidth: number;
  fallbackHeight: number;
  fallbackByteOffset: number;
  fallbackByteLength: number;
  charts: ChunkChartIndexRecord[];
  fallbackCharts?: ChunkFallbackRect[];
  tiles: XvlmTileRecord[];
}

export interface ChunkLightmapPackageInput {
  revision: string;
  metresPerTexel: number;
  tileSize: number;
  border: number;
  fallbackWidth: number;
  fallbackHeight: number;
  fallback: Uint16Array;
  charts: ChunkChartIndexRecord[];
  fallbackCharts?: ChunkFallbackRect[];
  tiles: Array<ChunkTileIndexRecord & { pixels: Uint16Array }>;
}

export interface DecodedChunkLightmapPackage {
  readonly revision: string;
  readonly metresPerTexel: number;
  readonly tileSize: number;
  readonly border: number;
  readonly fallbackWidth: number;
  readonly fallbackHeight: number;
  readonly fallback: Uint16Array;
  readonly fallbackCharts: ChunkFallbackRect[];
  readonly index: ChunkLightmapIndex;
  readonly storeBytes: number;
  tile(localTile: number): Uint16Array;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function hex(data: Uint8Array): string {
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function digest(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function validateInput(input: ChunkLightmapPackageInput): void {
  if (!input.revision.trim()) throw new Error('XVLM revision is required');
  if (!Number.isFinite(input.metresPerTexel) || input.metresPerTexel <= 0) throw new Error('XVLM metresPerTexel must be positive');
  if (!Number.isInteger(input.tileSize) || input.tileSize < 1) throw new Error('XVLM tileSize must be positive');
  if (!Number.isInteger(input.border) || input.border < 0) throw new Error('XVLM border must be non-negative');
  if (!Number.isInteger(input.fallbackWidth) || input.fallbackWidth < 1) throw new Error('XVLM fallbackWidth must be positive');
  if (!Number.isInteger(input.fallbackHeight) || input.fallbackHeight < 1) throw new Error('XVLM fallbackHeight must be positive');
  if (input.fallback.length !== input.fallbackWidth * input.fallbackHeight * 4) throw new Error('XVLM fallback size does not match dimensions');
  if (input.charts.length < 1) throw new Error('XVLM needs at least one chart');

  const fallbackCharts = input.fallbackCharts ?? (
    input.charts.length === 1
      ? [{ x: 0, y: 0, width: input.fallbackWidth, height: input.fallbackHeight }]
      : []
  );
  if (fallbackCharts.length !== input.charts.length) throw new Error('XVLM fallback chart count must match chart count');
  for (const [chart, rect] of fallbackCharts.entries()) {
    if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.width) || !Number.isInteger(rect.height)) {
      throw new Error(`XVLM fallback chart ${chart} has non-integer bounds`);
    }
    if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) throw new Error(`XVLM fallback chart ${chart} has invalid bounds`);
    if (rect.x + rect.width > input.fallbackWidth || rect.y + rect.height > input.fallbackHeight) {
      throw new Error(`XVLM fallback chart ${chart} exceeds fallback image`);
    }
    if (rect.width > input.tileSize || rect.height > input.tileSize) throw new Error(`XVLM fallback chart ${chart} exceeds tileSize`);
  }

  const physicalTile = input.tileSize + input.border * 2;
  const expectedTileWords = physicalTile * physicalTile * 4;
  for (const [tile, record] of input.tiles.entries()) {
    if (record.pixels.length !== expectedTileWords) throw new Error(`XVLM tile ${tile} has ${record.pixels.length} words, expected ${expectedTileWords}`);
    if (!Number.isInteger(record.chart) || record.chart < 0 || record.chart >= input.charts.length) throw new Error(`XVLM tile ${tile} has invalid chart`);
    if (record.parent !== null && (!Number.isInteger(record.parent) || record.parent < 0 || record.parent >= input.tiles.length)) throw new Error(`XVLM tile ${tile} has invalid parent`);
  }

  for (const [chart, record] of input.charts.entries()) {
    if (record.tileStart < 0 || record.tileCount < 0 || record.tileStart + record.tileCount > input.tiles.length) {
      throw new Error(`XVLM chart ${chart} tile range is invalid`);
    }
  }

  validateChunkLightmapIndex({
    revision: input.revision,
    charts: input.charts,
    tiles: input.tiles.map(({ chart, level, tileX, tileY, parent }) => ({ chart, level, tileX, tileY, parent })),
  });
}

export async function encodeChunkLightmapPackage(input: ChunkLightmapPackageInput): Promise<ArrayBuffer> {
  validateInput(input);

  const fallbackBytes = new Uint8Array(input.fallback.buffer, input.fallback.byteOffset, input.fallback.byteLength);
  let payloadBytes = align4(fallbackBytes.byteLength);
  const tileRecords: XvlmTileRecord[] = [];

  for (const tile of input.tiles) {
    const byteLength = tile.pixels.byteLength;
    tileRecords.push({
      chart: tile.chart,
      level: tile.level,
      tileX: tile.tileX,
      tileY: tile.tileY,
      parent: tile.parent,
      byteOffset: payloadBytes,
      byteLength,
    });
    payloadBytes = align4(payloadBytes + byteLength);
  }

  const metadata: XvlmMetadata = {
    revision: input.revision,
    metresPerTexel: input.metresPerTexel,
    tileSize: input.tileSize,
    border: input.border,
    fallbackWidth: input.fallbackWidth,
    fallbackHeight: input.fallbackHeight,
    fallbackByteOffset: 0,
    fallbackByteLength: fallbackBytes.byteLength,
    charts: input.charts,
    fallbackCharts: input.fallbackCharts ?? [{ x: 0, y: 0, width: input.fallbackWidth, height: input.fallbackHeight }],
    tiles: tileRecords,
  };

  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const metadataPadded = align4(metadataBytes.byteLength);
  const contentBytes = XVLM_HEADER_BYTES + metadataPadded + payloadBytes;
  const buffer = new ArrayBuffer(contentBytes + XVLM_DIGEST_BYTES);
  const header = new DataView(buffer, 0, XVLM_HEADER_BYTES);
  header.setUint32(0, XVLM_MAGIC, true);
  header.setUint32(4, XVLM_VERSION, true);
  header.setUint32(8, metadataBytes.byteLength, true);
  header.setUint32(12, payloadBytes, true);

  const output = new Uint8Array(buffer);
  output.fill(0x20, XVLM_HEADER_BYTES, XVLM_HEADER_BYTES + metadataPadded);
  output.set(metadataBytes, XVLM_HEADER_BYTES);

  const payloadOffset = XVLM_HEADER_BYTES + metadataPadded;
  output.set(fallbackBytes, payloadOffset);
  for (let tile = 0; tile < input.tiles.length; tile++) {
    const pixels = input.tiles[tile].pixels;
    output.set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), payloadOffset + tileRecords[tile].byteOffset);
  }

  const checksum = await digest(new Uint8Array(buffer, 0, contentBytes));
  output.set(checksum, contentBytes);
  return buffer;
}

export async function decodeChunkLightmapPackage(buffer: ArrayBuffer): Promise<DecodedChunkLightmapPackage> {
  if (buffer.byteLength < XVLM_HEADER_BYTES + XVLM_DIGEST_BYTES) throw new Error('XVLM is truncated');
  const header = new DataView(buffer, 0, XVLM_HEADER_BYTES);
  if (header.getUint32(0, true) !== XVLM_MAGIC) throw new Error('XVLM magic mismatch');
  if (header.getUint32(4, true) !== XVLM_VERSION) throw new Error('XVLM version is unsupported');

  const metadataLength = header.getUint32(8, true);
  const payloadLength = header.getUint32(12, true);
  const metadataPadded = align4(metadataLength);
  const contentBytes = XVLM_HEADER_BYTES + metadataPadded + payloadLength;
  if (contentBytes + XVLM_DIGEST_BYTES !== buffer.byteLength) throw new Error('XVLM length mismatch');

  const expected = new Uint8Array(buffer, contentBytes, XVLM_DIGEST_BYTES);
  const actual = await digest(new Uint8Array(buffer, 0, contentBytes));
  if (hex(expected) !== hex(actual)) throw new Error('XVLM checksum mismatch');

  const metadataText = new TextDecoder().decode(new Uint8Array(buffer, XVLM_HEADER_BYTES, metadataLength));
  const metadata = JSON.parse(metadataText) as XvlmMetadata;
  const payloadOffset = XVLM_HEADER_BYTES + metadataPadded;

  if (!metadata.revision?.trim()) throw new Error('XVLM metadata has no revision');
  if (!Number.isFinite(metadata.metresPerTexel) || metadata.metresPerTexel <= 0) throw new Error('XVLM metadata has invalid metresPerTexel');
  if (!Number.isInteger(metadata.tileSize) || metadata.tileSize < 1) throw new Error('XVLM metadata has invalid tileSize');
  if (!Number.isInteger(metadata.border) || metadata.border < 0) throw new Error('XVLM metadata has invalid border');
  if (!Number.isInteger(metadata.fallbackWidth) || metadata.fallbackWidth < 1) throw new Error('XVLM metadata has invalid fallbackWidth');
  if (!Number.isInteger(metadata.fallbackHeight) || metadata.fallbackHeight < 1) throw new Error('XVLM metadata has invalid fallbackHeight');
  if (!Array.isArray(metadata.charts) || metadata.charts.length < 1) throw new Error('XVLM metadata has no charts');
  if (!Array.isArray(metadata.tiles)) throw new Error('XVLM metadata has no tile index');
  const fallbackCharts = metadata.fallbackCharts ?? (
    metadata.charts.length === 1
      ? [{ x: 0, y: 0, width: metadata.fallbackWidth, height: metadata.fallbackHeight }]
      : []
  );
  if (fallbackCharts.length !== metadata.charts.length) throw new Error('XVLM metadata fallback chart count mismatch');
  for (const [chart, rect] of fallbackCharts.entries()) {
    if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.width) || !Number.isInteger(rect.height)) {
      throw new Error(`XVLM fallback chart ${chart} has non-integer bounds`);
    }
    if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) throw new Error(`XVLM fallback chart ${chart} has invalid bounds`);
    if (rect.x + rect.width > metadata.fallbackWidth || rect.y + rect.height > metadata.fallbackHeight) {
      throw new Error(`XVLM fallback chart ${chart} exceeds fallback image`);
    }
    if (rect.width > metadata.tileSize || rect.height > metadata.tileSize) throw new Error(`XVLM fallback chart ${chart} exceeds tileSize`);
  }

  const fallbackWords = metadata.fallbackWidth * metadata.fallbackHeight * 4;
  if (
    metadata.fallbackByteOffset !== 0 ||
    metadata.fallbackByteLength !== fallbackWords * 2 ||
    metadata.fallbackByteLength > payloadLength
  ) throw new Error('XVLM fallback range is invalid');

  const fallback = new Uint16Array(
    buffer,
    payloadOffset + metadata.fallbackByteOffset,
    fallbackWords,
  );

  const physicalTile = metadata.tileSize + metadata.border * 2;
  const expectedTileBytes = physicalTile * physicalTile * 4 * 2;
  for (const [tile, record] of metadata.tiles.entries()) {
    if (
      record.byteLength !== expectedTileBytes ||
      record.byteOffset < metadata.fallbackByteLength ||
      record.byteOffset + record.byteLength > payloadLength ||
      record.byteOffset % 4 !== 0
    ) throw new Error(`XVLM tile ${tile} payload range is invalid`);
  }

  const index: ChunkLightmapIndex = {
    revision: metadata.revision,
    charts: metadata.charts,
    tiles: metadata.tiles.map((record) => ({
      chart: record.chart,
      level: record.level,
      tileX: record.tileX,
      tileY: record.tileY,
      parent: record.parent,
    })),
  };
  validateChunkLightmapIndex(index);

  return {
    revision: metadata.revision,
    metresPerTexel: metadata.metresPerTexel,
    tileSize: metadata.tileSize,
    border: metadata.border,
    fallbackWidth: metadata.fallbackWidth,
    fallbackHeight: metadata.fallbackHeight,
    fallback,
    fallbackCharts,
    index,
    storeBytes: payloadLength,
    tile(localTile: number): Uint16Array {
      const record = metadata.tiles[localTile];
      if (!record) throw new Error(`XVLM has no tile ${localTile}`);
      return new Uint16Array(buffer, payloadOffset + record.byteOffset, record.byteLength / 2);
    },
  };
}

export async function loadChunkLightmapPackage(url: string, signal?: AbortSignal): Promise<DecodedChunkLightmapPackage> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`XVLM load failed ${url}: HTTP ${response.status}`);
  return decodeChunkLightmapPackage(await response.arrayBuffer());
}
