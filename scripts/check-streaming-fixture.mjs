import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

assert.equal(manifest.version, 1);
assert.equal(manifest.chunks.length, 1);
const asset = manifest.chunks[0].assets[0];
assert.equal(asset.provenance.clearance, 'xinba-owned');
assert.match(asset.provenance.source, /Original procedural streaming fixture/);

const active = parseGlb(await readFile(`public${asset.activeGlb}`));
const proxy = parseGlb(await readFile(`public${asset.proxyGlb}`));

assert.ok(active.triangles > proxy.triangles, `Active must exceed Proxy detail: ${active.triangles} vs ${proxy.triangles}`);
assert.ok(active.vertices > proxy.vertices, `Active must exceed Proxy vertices: ${active.vertices} vs ${proxy.vertices}`);
assert.match(active.generator, /Xinba procedural streaming fixture/);
assert.match(proxy.generator, /Xinba procedural streaming fixture/);

console.log(JSON.stringify({ active, proxy, ratio: +(active.triangles / proxy.triangles).toFixed(2) }, null, 2));
console.log('check-streaming-fixture: PASS');
