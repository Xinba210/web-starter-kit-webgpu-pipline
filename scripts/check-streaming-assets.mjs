import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

const port = process.env.PORT ?? '5188';
const out = 'shots/streaming';
const bound = Number(process.env.BOUND ?? 90000);
await mkdir(out, { recursive: true });

const url =
  `http://127.0.0.1:${port}/?scene=lod-scale&cam=streaming&chunks=asset&hud=0` +
  '&chunkSize=18&chunkActive=0.55&chunkPrefetch=2.2&chunkUnload=3.2&chunkLookAhead=0' +
  '&chunkLoads=8&chunkUnloads=8&reflections=0&aa=none&surfelGi=0';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

const waitFrames = (frames) => page.evaluate((count) => new Promise((resolve) => {
  let frame = 0;
  const next = () => {
    frame++;
    if (frame >= count) resolve(true);
    else requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
}), frames);

const state = () => page.evaluate(() => {
  const stream = window.__streaming?.();
  const scene = window.__fog?.frameGraph?.().scene;
  const active = scene?.getObjectByName('streamed-active-xinba-pavilion-fixture');
  const proxy = scene?.getObjectByName('streamed-proxy-xinba-pavilion-fixture');
  const visibleInHierarchy = (object) => {
    if (!object) return false;
    let current = object;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  };
  let bakedReceivers = 0;
  active?.traverse((object) => {
    if (object.isMesh && object.userData.bakedLightReceiver === true) bakedReceivers++;
  });
  return {
    stream,
    activeExists: !!active,
    activeVisible: visibleInHierarchy(active),
    proxyExists: !!proxy,
    proxyVisible: visibleInHierarchy(proxy),
    bakedReceivers,
  };
});

const bakedFrameStats = async (name) => {
  const visibility = await page.evaluate(() => {
    const scene = window.__fog.frameGraph().scene;
    const activeChunk = scene.getObjectByName('streamed-active-chunk-0-0');
    const state = scene.children.map((child) => [child.uuid, child.visible]);
    for (const child of scene.children) child.visible = child === activeChunk;
    window.__fog.split('baked', 0);
    return state;
  });
  await waitFrames(12);
  const path = `${out}/${name}.png`;
  await page.locator('canvas').screenshot({ path });
  const image = PNG.sync.read(await readFile(path));
  let nonBlack = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const luma = 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
    sum += luma;
    max = Math.max(max, luma);
    if (luma > 2) nonBlack++;
  }
  await page.evaluate((state) => {
    const scene = window.__fog.frameGraph().scene;
    const byId = new Map(state);
    for (const child of scene.children) {
      const visible = byId.get(child.uuid);
      if (visible !== undefined) child.visible = visible;
    }
    window.__fog.split('off', 0.5);
  }, visibility);
  await waitFrames(6);
  return {
    nonBlack,
    fraction: nonBlack / (image.width * image.height),
    meanLuma: sum / (image.width * image.height),
    maxLuma: max,
  };
};

const move = async (x, z, targetX, targetZ) => {
  await page.evaluate(([px, pz, tx, tz]) => window.__camera(px, 7, pz, tx, 2.2, tz), [x, z, targetX, targetZ]);
  await waitFrames(12);
};

const waitFor = async (predicate, message) => {
  const ok = await page.waitForFunction(predicate, null, { timeout: bound, polling: 100 }).then(() => true).catch(() => false);
  assert.ok(ok, message);
};

const report = {};
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(
    () => document.querySelector('#loading-overlay')?.hidden && window.__streaming && window.__fog,
    'pipeline did not boot',
  );
  await waitFor(
    () => {
      const s = window.__streaming?.();
      const scene = window.__fog?.frameGraph?.().scene;
      return s?.dynamicMovers > 0 &&
        s?.lighting?.readyChunks === 1 &&
        s?.lighting?.chartsUsed === 1 &&
        scene?.getObjectByName('streamed-active-xinba-pavilion-fixture')?.visible === true;
    },
    'Active GLB did not enter the dynamic BVH',
  );

  report.active = await state();
  await page.screenshot({ path: `${out}/active.png` });
  const staticRevision = report.active.stream.staticSceneRevision;
  const activeDynamicRevision = report.active.stream.dynamicSceneRevision;

  assert.equal(report.active.activeVisible, true, 'near camera must show Active GLB');
  assert.equal(report.active.proxyVisible, false, 'near camera must hide Proxy GLB');
  assert.ok(report.active.stream.dynamicTriangles > 0, 'Active GLB must contribute dynamic BVH triangles');
  assert.ok(report.active.stream.dynamicMovers > 0, 'Active GLB must contribute a dynamic BVH mover');
  assert.equal(report.active.stream.lighting.readyChunks, 1, 'Active chunk must validate and register its XVLM package');
  assert.equal(report.active.stream.lighting.chartsUsed, 1, 'XVLM chart must occupy the world chart registry');
  assert.equal(report.active.stream.lighting.packageTileSize, 64, 'XVLM tile shape must reach runtime diagnostics');
  assert.equal(report.active.stream.lighting.fallback.pinned, 1, 'Active XVLM chart must own one pinned GPU fallback slot');
  assert.ok(report.active.stream.lighting.fallback.uploadedKiBLastPin > 0, 'fallback pixels must be uploaded to the GPU pool');
  assert.ok(report.active.stream.lighting.fallback.uploadedPageKiBLastChange > 0, 'world lightmap page table must upload an active chart entry');
  assert.ok(report.active.bakedReceivers > 0, 'Active GLB must become a baked-light receiver only after XVLM fallback is ready');

  report.bakedOnly = await bakedFrameStats('active-baked-only');
  assert.ok(report.bakedOnly.nonBlack > 100, `streamed baked-only frame is black: ${JSON.stringify(report.bakedOnly)}`);
  assert.ok(report.bakedOnly.maxLuma > 4, `streamed baked-only signal is too weak: ${JSON.stringify(report.bakedOnly)}`);

  await move(28, 9, 0, 2);
  await waitFor(
    () => {
      const scene = window.__fog?.frameGraph?.().scene;
      const s = window.__streaming?.();
      return scene?.getObjectByName('streamed-proxy-xinba-pavilion-fixture')?.visible === true &&
        scene?.getObjectByName('streamed-active-xinba-pavilion-fixture')?.visible === false &&
        s?.dynamicMovers === 0;
    },
    'chunk did not demote to Proxy cleanly',
  );
  report.proxy = await state();
  await page.screenshot({ path: `${out}/proxy.png` });

  assert.equal(report.proxy.stream.staticSceneRevision, staticRevision, 'Proxy transition must not rebuild Static BVH');
  assert.ok(report.proxy.stream.dynamicSceneRevision > activeDynamicRevision, 'Proxy transition must revise Dynamic BVH membership');
  assert.equal(report.proxy.proxyVisible, true, 'prefetch range must show Proxy GLB');
  assert.equal(report.proxy.stream.dynamicTriangles, 0, 'Proxy GLB must stay out of dynamic BVH');
  assert.equal(report.proxy.stream.lighting.activeChunks, 0, 'Proxy tier must release Active chunk lighting ownership');
  assert.equal(report.proxy.stream.lighting.chartsUsed, 0, 'Proxy tier must release world chart slots');
  assert.equal(report.proxy.stream.lighting.fallback.pinned, 0, 'Proxy tier must release pinned GPU fallback slots');
  assert.equal(report.proxy.bakedReceivers, 0, 'Proxy tier must remove streamed baked-light receiver state');

  await move(82, 9, 82, 0);
  await waitFor(
    () => {
      const scene = window.__fog?.frameGraph?.().scene;
      const resident = window.__chunks?.resident?.() ?? [];
      return !scene?.getObjectByName('streamed-active-xinba-pavilion-fixture') &&
        !scene?.getObjectByName('streamed-proxy-xinba-pavilion-fixture') &&
        !resident.includes('0:0');
    },
    'chunk did not unload outside hysteresis radius',
  );
  report.unloaded = await state();
  await page.screenshot({ path: `${out}/unloaded.png` });

  assert.equal(report.unloaded.stream.staticSceneRevision, staticRevision, 'unload must not rebuild Static BVH');
  assert.equal(report.unloaded.activeExists, false, 'unloaded Active GLB must leave the scene');
  assert.equal(report.unloaded.proxyExists, false, 'unloaded Proxy GLB must leave the scene');
  assert.equal(report.unloaded.stream.lighting.chartsUsed, 0, 'unloaded chunk must not retain lightmap chart slots');
  assert.equal(report.unloaded.stream.lighting.fallback.pinned, 0, 'unloaded chunk must not retain fallback slots');

  const beforeReturnRevision = report.unloaded.stream.dynamicSceneRevision;
  await move(9, 10, 0, 2);
  await waitFor(
    () => {
      const s = window.__streaming?.();
      const scene = window.__fog?.frameGraph?.().scene;
      return s?.dynamicMovers > 0 &&
        s?.lighting?.readyChunks === 1 &&
        scene?.getObjectByName('streamed-active-xinba-pavilion-fixture')?.visible === true;
    },
    'returning to the chunk did not reload Active GLB',
  );
  report.returned = await state();
  await page.screenshot({ path: `${out}/returned.png` });

  assert.equal(report.returned.stream.staticSceneRevision, staticRevision, 'reload must not rebuild Static BVH');
  assert.ok(report.returned.stream.dynamicSceneRevision > beforeReturnRevision, 'reload must revise Dynamic BVH membership');
  assert.equal(report.returned.activeVisible, true, 'returning must restore Active GLB');
  assert.equal(report.returned.proxyVisible, false, 'returning must hide Proxy GLB');
  assert.equal(report.returned.stream.lighting.readyChunks, 1, 'returning must reload and validate XVLM');
  assert.equal(report.returned.stream.lighting.chartsUsed, 1, 'returning Active chunk must reacquire chart ownership');
  assert.equal(report.returned.stream.lighting.fallback.pinned, 1, 'returning Active chunk must reacquire a pinned fallback slot');
  assert.ok(report.returned.bakedReceivers > 0, 'returning Active chunk must restore baked-light receiver state');

  assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
  await writeFile(`${out}/check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('check-streaming-assets: PASS');
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ report, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
