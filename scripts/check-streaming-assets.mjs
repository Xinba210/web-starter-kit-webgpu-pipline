import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

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
  return {
    stream,
    activeExists: !!active,
    activeVisible: active?.visible ?? false,
    proxyExists: !!proxy,
    proxyVisible: proxy?.visible ?? false,
  };
});

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
      return s?.dynamicMovers > 0 && scene?.getObjectByName('streamed-active-xinba-pavilion-fixture')?.visible === true;
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

  const beforeReturnRevision = report.unloaded.stream.dynamicSceneRevision;
  await move(9, 10, 0, 2);
  await waitFor(
    () => {
      const s = window.__streaming?.();
      const scene = window.__fog?.frameGraph?.().scene;
      return s?.dynamicMovers > 0 && scene?.getObjectByName('streamed-active-xinba-pavilion-fixture')?.visible === true;
    },
    'returning to the chunk did not reload Active GLB',
  );
  report.returned = await state();
  await page.screenshot({ path: `${out}/returned.png` });

  assert.equal(report.returned.stream.staticSceneRevision, staticRevision, 'reload must not rebuild Static BVH');
  assert.ok(report.returned.stream.dynamicSceneRevision > beforeReturnRevision, 'reload must revise Dynamic BVH membership');
  assert.equal(report.returned.activeVisible, true, 'returning must restore Active GLB');
  assert.equal(report.returned.proxyVisible, false, 'returning must hide Proxy GLB');

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
