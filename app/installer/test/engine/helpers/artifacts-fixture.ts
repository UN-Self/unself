// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 最小「安装器产物」夹具（#257/#284 测试用）：**从零合成**一棵 artifacts 树，不从仓库抄任何文件。
 *
 * 为什么从零合成：测试要证的是「引擎在产物模式下不读仓库」——夹具若从仓库 app/modules、app/workbench 拷贝，
 * 就分不清「引擎读了产物」还是「引擎偷读了仓库」。合成夹具 + 空 rootDir ⇒ 任何仓库读取都会因文件不存在炸掉。
 *
 * #284 起产物里**只有平台产物**（core worker / shell / 迁移 SQL / vendor）：模块与浏览器侧 SDK
 * 都是普通 npm 包，由 node_modules 解析（本地优先）。夹具因此不再合成 `modules/` 与 `sdk/`。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** core Worker 产物内容（测试里不需要真跑，只需被搬运 + 上传）。 */
export const FAKE_CORE_WORKER = `// SPDX-License-Identifier: AGPL-3.0-only
// 夹具 core Worker（非真实产物）
export default { fetch() { return new Response('core'); } };
`;

/** 合成产物根：manifest.json + core/worker.js + core/migrations/{core,modules} + shell + vendor。 */
export async function writeArtifactFixture(root: string): Promise<void> {
  await mkdir(join(root, 'core', 'migrations', 'core'), { recursive: true });
  await mkdir(join(root, 'core', 'migrations', 'modules'), { recursive: true });
  await mkdir(join(root, 'shell'), { recursive: true });
  await mkdir(join(root, 'vendor'), { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        installerVersion: '0.0.0-test',
        generatedAt: '2026-01-01T00:00:00.000Z',
        layout: { coreWorker: 'core/worker.js', coreMigrations: 'core/migrations/core', platformMigrations: 'core/migrations/modules', shell: 'shell', vendor: 'vendor' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'core', 'worker.js'), FAKE_CORE_WORKER);
  // 夹具 core 迁移：一条无害幂等语句（fake D1 只记账，不真跑 SQL）
  await writeFile(
    join(root, 'core', 'migrations', 'core', '0001_init.sql'),
    'CREATE TABLE IF NOT EXISTS fixture_core (id TEXT PRIMARY KEY);\n',
  );
  await writeFile(join(root, 'shell', 'index.html'), '<html><body>FIXTURE SHELL</body></html>\n');
  await writeFile(join(root, 'shell', '_headers'), '/*\n  X-Fixture: 1\n');
}
