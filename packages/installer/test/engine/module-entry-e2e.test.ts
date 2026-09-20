// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #269 验收 e2e（引擎侧）：
 * 1. **真远端取包**：把 `modules/hello` 用 `unself module pack` 打进 .tgz，经 loopback HTTP
 *    （`http://127.0.0.1:<port>/hello-0.1.0.tgz`）真实 `fetch` 下载 → 九步装配成功；
 * 2. **「同内容的本地 tarball 结果一致」**（验收③）：tarball 来源装配出来的 module worker
 *    与 npm 本地命中（仓库源码形态）装配逐字节相同（且等于 pack 产出的 worker.js）——#284 起
 *    「本地优先」的两种来源（node_modules 源码形态 / 远端 tarball 打包形态）必须产出同一份产物；
 * 3. **篡改包必红**：lock 已锁定 SRI，干净重跑（暂存清空）取到篡改字节 → 拒绝安装。
 *
 * CF 侧为替身（`makeCfRestFake`）；取包/解包/SRI 校验走真实代码。真机探针另见 /tmp/report-269.md。
 */
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modulePackageFiles, packModuleDir } from '../../src/engine/module-pack';
import { writeTarball } from '../../src/engine/tar-write';
import { runNineSteps } from '../../src/engine/steps';
import { parseLockText } from '../../src/engine/lock';
import { sriFromBuffer } from '../../src/engine/sources';
import { RestClient } from '../../src/engine/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';

const ROOT = new URL('../../../..', import.meta.url).pathname;
const HELLO_DIR = join(ROOT, 'modules/hello');
const LOCK_PATH = join(ROOT, 'unself.lock');
const DEPLOY_DIR = join(ROOT, '.deploy');

async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    ([{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }] as Array<{
      name: string;
      url: string;
      ok: boolean;
      status: number;
    }>).concat(mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 }))),
};

/** loopback 取包服务（真 HTTP；记录命中次数以证「确实走了远端取包」）。 */
let server: Server;
let served: Buffer = Buffer.alloc(0);
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.endsWith('.tgz')) {
      hits++;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(served);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(DEPLOY_DIR, { recursive: true, force: true });
  await rm(LOCK_PATH, { force: true });
});

function port(): number {
  return (server.address() as { port: number }).port;
}

/** 跑一次九步（repo 形态 + 替身 CF；模块清单由调用方给）。 */
async function runDeploy(modules: Array<{ id: string; source: string }>, opts: { yes?: boolean } = {}) {
  const fake = makeCfRestFake();
  const summary = await runNineSteps({
    rootDir: ROOT,
    client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
    configOverride: {
      domain: '',
      modules,
      storage: { provider: 'r2', bucket: 'unself-storage' },
    },
    http: SMOKE_OK,
    buildShell: fakeBuildShell,
    ...(opts.yes ? { yes: true } : {}),
  });
  return { fake, summary };
}

describe.sequential('#269 e2e：真远端取包 + 结果一致 + 篡改必红', () => {
  it('npm 本地命中 与 loopback http tarball 装配结果逐字节一致，且 lock 记下来源/SRI', { timeout: 180_000 }, async () => {
    await rm(DEPLOY_DIR, { recursive: true, force: true });
    await rm(LOCK_PATH, { force: true });
    const out = join(ROOT, '.scratch-e2e-pack');
    await rm(out, { recursive: true, force: true });
    const packed = await packModuleDir({ dir: HELLO_DIR, outDir: out });
    served = await readFile(packed.tarballPath);
    hits = 0;

    // ① 官方模块（npm 本地命中 → 仓库源码形态，装配期 esbuild 打包）
    await runDeploy([{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], { yes: true });
    const builtinApp = await readFile(join(DEPLOY_DIR, 'cloudflare/modules/hello/app.js'));

    // ② 真远端来源（loopback HTTP；不带任何 fetchers 替身）
    const source = `http://127.0.0.1:${port()}/hello-0.1.0.tgz`;
    await runDeploy([{ id: 'hello', source }], { yes: true });
    const sourcedApp = await readFile(join(DEPLOY_DIR, 'cloudflare/modules/hello/app.js'));

    expect(hits).toBeGreaterThan(0); // 真的出网取了包
    const packedWorker = (await modulePackageFiles({ dir: HELLO_DIR })).files.find((f) => f.name === 'worker.js');
    expect(packedWorker).toBeDefined();
    expect(sourcedApp.equals(builtinApp)).toBe(true);
    expect(sourcedApp.equals(packedWorker!.data)).toBe(true);

    const lock = parseLockText(await readFile(LOCK_PATH, 'utf8'));
    expect(lock.modules.hello?.source).toBe(source);
    expect(lock.modules.hello?.integrity).toBe(sriFromBuffer(served));

    await rm(out, { recursive: true, force: true });
  });

  it('lock 已锁定后：暂存清空重取到篡改字节 → 拒绝安装（红灯）', { timeout: 180_000 }, async () => {
    // 先正常装一次，拿到 lock（含 integrity）
    await rm(DEPLOY_DIR, { recursive: true, force: true });
    await rm(LOCK_PATH, { force: true });
    const out = join(ROOT, '.scratch-e2e-pack2');
    await rm(out, { recursive: true, force: true });
    const packed = await packModuleDir({ dir: HELLO_DIR, outDir: out });
    served = await readFile(packed.tarballPath);
    const source = `http://127.0.0.1:${port()}/hello-0.1.0.tgz`;
    await runDeploy([{ id: 'hello', source }], { yes: true });
    expect(parseLockText(await readFile(LOCK_PATH, 'utf8')).modules.hello?.integrity).toBeDefined();

    // 篡改：改 worker.js 一个字节重新打包（manifest 不变 → manifestHash 不变，只有 SRI 变）
    const files = (await modulePackageFiles({ dir: HELLO_DIR })).files.map((f) => ({ ...f }));
    const worker = files.find((f) => f.name === 'worker.js')!;
    worker.data = Buffer.concat([worker.data, Buffer.from('\n// tampered by red-light test\n')]);
    const tamperedPath = join(out, 'tampered.tgz');
    await writeTarball(files.map((f) => ({ name: `package/${f.name}`, data: f.data })), tamperedPath);
    served = await readFile(tamperedPath);

    // 模拟干净机器重跑：清掉暂存包（不碰 lock）→ 触发重新取包（暂存路径 = 引擎 outDir/module-sources/<id>）
    await rm(join(DEPLOY_DIR, 'cloudflare/module-sources/hello'), { recursive: true, force: true });
    await expect(runDeploy([{ id: 'hello', source }], { yes: true })).rejects.toThrow(/integrity|拒绝安装/);

    await rm(out, { recursive: true, force: true });
  });

  it('lock 已锁定后：包内 manifest 版本被改（暂存在盘）→ manifestHash 不匹配，拒绝安装（红灯）', { timeout: 180_000 }, async () => {
    await rm(DEPLOY_DIR, { recursive: true, force: true });
    await rm(LOCK_PATH, { force: true });
    const out = join(ROOT, '.scratch-e2e-pack3');
    await rm(out, { recursive: true, force: true });
    const packed = await packModuleDir({ dir: HELLO_DIR, outDir: out });
    served = await readFile(packed.tarballPath);
    const source = `http://127.0.0.1:${port()}/hello-0.1.0.tgz`;
    await runDeploy([{ id: 'hello', source }], { yes: true });

    // 把暂存包里的 manifest 版本改掉（包字节没重下，但内容变了）→ reuse 路径的 manifestHash 必不一致
    const stagedManifest = join(DEPLOY_DIR, 'cloudflare/module-sources/hello/package/manifest.json');
    const manifest = JSON.parse(await readFile(stagedManifest, 'utf8')) as Record<string, unknown>;
    manifest.version = '9.9.9';
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(runDeploy([{ id: 'hello', source }], { yes: true })).rejects.toThrow(/manifestHash|拒绝安装/);

    await rm(out, { recursive: true, force: true });
  });
});
