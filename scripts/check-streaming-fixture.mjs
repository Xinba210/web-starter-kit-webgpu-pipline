import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = 'public/streaming/xinba-pavilion';
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));

function parseGlb(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(buffer.readUInt32LE(4), 2, 'GLB version');
  assert.equal(buffer.readUInt32LE(8), buffer.length, 'GLB length');
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk');
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const primitive = json.meshes[0].primitives[0];
  const indexAccessor = json.accessors[primitive.indices];
  const positionAccessor = json.accessors[primitive.attributes.POSITION];
  return {
    triangles: indexAccessor.count / 3,
    vertices: positionAccessor.count,
    generator: json.asset.generator,
  };
}

function parseXvlm(buffer) {
  assert.ok(buffer.length >= 48, 'XVLM minimum length');
  assert.equal(buffer.readUInt32LE(0), 0x4d4c5658, 'XVLM magic');
  assert.equal(buffer.readUInt32LE(4), 1, 'XVLM version');
  const metadataLength = buffer.readUInt32LE(8);
  const payloadLength = buffer.readUInt32LE(12);
  const metadataPadded = (metadataLength + 3) & ~3;
  const contentBytes = 16 + metadataPadded + payloadLength;
  assert.equal(contentBytes + 32, buffer.length, 'XVLM length');
  const expected = buffer.subarray(contentBytes);
  const actual = createHash('sha256').update(buffer.subarray(0, contentBytes)).digest();
  assert.equal(actual.toString('hex'), expected.toString('hex'), 'XVLM checksum');
  const metadata = JSON.parse(buffer.subarray(16, 16 + metadataLength).toString('utf8'));
  return { metadata, payloadLength };
}

assert.equal(manifest.version, 1);
assert.equal(manifest.chunks.length, 1);
const asset = manifest.chunks[0].assets[0];
assert.equal(asset.provenance.clearance, 'xinba-owned');
assert.match(asset.provenance.source, /Original procedural streaming fixture/);

const active = parseGlb(await readFile(`public${asset.activeGlb}`));
const proxy = parseGlb(await readFile(`public${asset.proxyGlb}`));
const lighting = manifest.chunks[0].lighting;
assert.ok(lighting, 'fixture manifest must carry chunk lighting');
const xvlm = parseXvlm(await readFile(`public${lighting.packageUrl}`));

assert.ok(active.triangles > proxy.triangles, `Active must exceed Proxy detail: ${active.triangles} vs ${proxy.triangles}`);
assert.ok(active.vertices > proxy.vertices, `Active must exceed Proxy vertices: ${active.vertices} vs ${proxy.vertices}`);
assert.match(active.generator, /Xinba procedural streaming fixture/);
assert.match(proxy.generator, /Xinba procedural streaming fixture/);
assert.equal(xvlm.metadata.revision, lighting.revision);
assert.equal(xvlm.metadata.charts.length, lighting.chartCount);
assert.equal(xvlm.metadata.metresPerTexel, lighting.metresPerTexel);
assert.equal(xvlm.metadata.tiles.length, 0);
assert.equal(xvlm.metadata.fallbackByteLength, 128);

console.log(JSON.stringify({
  active,
  proxy,
  ratio: +(active.triangles / proxy.triangles).toFixed(2),
  lighting: {
    revision: xvlm.metadata.revision,
    charts: xvlm.metadata.charts.length,
    tiles: xvlm.metadata.tiles.length,
    payloadBytes: xvlm.payloadLength,
  },
}, null, 2));
console.log('check-streaming-fixture: PASS');
