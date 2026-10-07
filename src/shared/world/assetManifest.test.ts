import { describe, expect, it } from 'vitest';
import {
  indexStreamedAssetManifest,
  validateStreamedAssetManifest,
  type StreamedAssetManifest,
} from './assetManifest.ts';

function manifest(clearance: 'xinba-owned' | 'cleared-commercial' | 'prototype-only'): StreamedAssetManifest {
  return {
    version: 1,
    chunks: [{
      coord: { x: 0, z: 0 },
      assets: [{
        id: 'village-house-a',
        activeGlb: '/assets/village/house-a.glb',
        proxyGlb: '/assets/village/house-a-proxy.glb',
        provenance: {
          clearance,
          source: 'Xinba production',
          licenseRef: clearance === 'cleared-commercial' ? 'licenses/vendor-a.txt' : undefined,
        },
      }],
    }],
  };
}

describe('streamed asset manifest', () => {
  it('accepts Xinba-owned production assets and indexes by deterministic chunk id', () => {
    const indexed = indexStreamedAssetManifest(manifest('xinba-owned'));
    expect(indexed.get('0:0')?.assets[0].id).toBe('village-house-a');
  });

  it('rejects prototype-only assets in a cleared build', () => {
    expect(() => validateStreamedAssetManifest(manifest('prototype-only'))).toThrow(/prototype-only/);
    expect(() => validateStreamedAssetManifest(manifest('prototype-only'), { allowPrototypeAssets: true })).not.toThrow();
  });

  it('requires a license reference for externally cleared commercial assets', () => {
    const value = manifest('cleared-commercial');
    value.chunks[0].assets[0].provenance.licenseRef = '';
    expect(() => validateStreamedAssetManifest(value)).toThrow(/license reference/);
  });

  it('validates chunk-owned lighting metadata before runtime registration', () => {
    const value = manifest('xinba-owned');
    value.chunks[0].lighting = {
      packageUrl: '/lighting/0-0.xvlm',
      chartCount: 12,
      revision: 'fixture-v1',
      metresPerTexel: 0.05,
    };
    expect(() => validateStreamedAssetManifest(value)).not.toThrow();
    value.chunks[0].lighting.chartCount = 0;
    expect(() => validateStreamedAssetManifest(value)).toThrow(/chartCount/);
  });

  it('rejects duplicate asset ids across chunks', () => {
    const value = manifest('xinba-owned');
    value.chunks.push({
      coord: { x: 1, z: 0 },
      assets: [{ ...value.chunks[0].assets[0] }],
    });
    expect(() => validateStreamedAssetManifest(value)).toThrow(/duplicate streamed asset id/);
  });
});
