// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 最小「安装器产物」夹具（#257 测试用）：**从零合成**一棵 artifacts 树，不从仓库抄任何文件。
 *
 * 为什么从零合成：测试要证的是「引擎在产物模式下不读仓库」——夹具若从仓库 modules/、services/ 拷贝，
 * 就分不清「引擎读了产物」还是「引擎偷读了仓库」。合成夹具 + 空 rootDir ⇒ 任何仓库读取都会因文件不存在炸掉。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** core Worker 产物内容（测试里不需要真跑，只需被搬运 + 上传）。 */
export const FAKE_CORE_WORKER = `// SPDX-License-Identifier: AGPL-3.0-only
// 夹具 core Worker（非真实产物）
export default { fetch() { return new Response('core'); } };
`;

/** hello 模块包的 manifest（契约 v1 必需字段）。 */
export const FAKE_HELLO_MANIFEST = {
  id: 'hello',
  version: '9.9.9',
  runtimes: ['worker'],
  route: '/m/hello',
  entry: 'https://fixture.test/m/hello/',
  permissions: ['storage'],
};

/** 缺失的模块包（用于「选中但产物里没有」的负例）。 */
export const FAKE_MISSING_MANIFEST = {
  id: 'ghost',
  version: '9.9.9',
  runtimes: ['worker'],
  route: '/m/ghost',
  entry: 'https://fixture.test/m/ghost/',
};

/**
 * 合成产物根：manifest.json + core/worker.js + core/migrations/{core,modules} + shell + sdk + modules/<id>。
 * @param root 目标目录（调用方负责建/删）
 */
export async function writeArtifactFixture(
  root: string,
  opts: { modules?: Array<{ id: string; manifest: unknown }> } = {},
): Promise<void> {
  const modules = opts.modules ?? [{ id: 'hello', manifest: FAKE_HELLO_MANIFEST }];
  await mkdir(join(root, 'core', 'migrations', 'core'), { recursive: true });
  await mkdir(join(root, 'core', 'migrations', 'modules'), { recursive: true });
  await mkdir(join(root, 'shell'), { recursive: true });
  await mkdir(join(root, 'sdk'), { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    `${JSON.stringify({ formatVersion: 1, installerVersion: '0.0.0-test', generatedAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
  );
  await writeFile(join(root, 'core', 'worker.js'), FAKE_CORE_WORKER);
  // 夹具 core 迁移：一条无害幂等语句（fake D1 只记账，不真跑 SQL）
  await writeFile(
    join(root, 'core', 'migrations', 'core', '0001_init.sql'),
    'CREATE TABLE IF NOT EXISTS fixture_core (id TEXT PRIMARY KEY);\n',
  );
  await writeFile(join(root, 'shell', 'index.html'), '<html><body>FIXTURE SHELL</body></html>\n');
  await writeFile(join(root, 'shell', '_headers'), '/*\n  X-Fixture: 1\n');
  await writeFile(join(root, 'sdk', 'module-sdk.js'), '/* fixture iife sdk */\n');
  await writeFile(join(root, 'sdk', 'module-sdk.esm.js'), 'export const createModuleSDK = () => ({});\n');
  for (const mod of modules) {
    const dir = join(root, 'modules', mod.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(mod.manifest, null, 2)}\n`);
    await writeFile(join(dir, 'worker.js'), `export default { fetch() { return new Response('${mod.id}'); } };\n`);
  }
}
