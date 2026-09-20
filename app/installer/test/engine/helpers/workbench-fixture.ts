// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 最小「平台产物包」夹具（#303 修订 #257 后测试用）：**从零合成**一个冒充 `@unself/workbench` 的包目录。
 *
 * 为什么从零合成：测试要证的是「引擎在平台产物形态下不读仓库源码树」——夹具若从仓库 `app/workbench`
 * 拷贝，就分不清「引擎读了产物」还是「引擎偷读了仓库」。合成夹具 + 空 rootDir ⇒ 任何仓库读取都会炸。
 *
 * 包形状（判据 = package.json 的 name）：
 * ```
 * <dir>/package.json            name=@unself/workbench
 * <dir>/dist/worker.js          core Worker bundle（测试里不需要真跑，只需被搬运 + 上传）
 * <dir>/dist/web/{index.html,_headers}  壳产物
 * <dir>/migrations/core/*.sql   core 迁移
 * <dir>/migrations/modules/*.sql 平台基建迁移
 * ```
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** core Worker 产物内容（测试里不需要真跑，只需被搬运 + 上传）。 */
export const FAKE_CORE_WORKER = `// SPDX-License-Identifier: AGPL-3.0-only
// 夹具 core Worker（非真实产物）
export default { fetch() { return new Response('core'); } };
`;

/** 合成「平台产物包」目录（返回目录本身，便于直接当 workbenchDir 用）。 */
export async function writeWorkbenchFixture(
  dir: string,
  options: { coreWorker?: string; version?: string } = {},
): Promise<string> {
  await mkdir(join(dir, 'dist', 'web'), { recursive: true });
  await mkdir(join(dir, 'migrations', 'core'), { recursive: true });
  await mkdir(join(dir, 'migrations', 'modules'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: '@unself/workbench', version: options.version ?? '0.0.0-test' }, null, 2)}\n`,
  );
  await writeFile(join(dir, 'dist', 'worker.js'), options.coreWorker ?? FAKE_CORE_WORKER);
  await writeFile(join(dir, 'dist', 'web', 'index.html'), '<html><body>FIXTURE SHELL</body></html>\n');
  await writeFile(join(dir, 'dist', 'web', '_headers'), '/*\n  X-Fixture: 1\n');
  // 夹具 core 迁移：一条无害幂等语句（fake D1 只记账，不真跑 SQL）
  await writeFile(
    join(dir, 'migrations', 'core', '0001_init.sql'),
    'CREATE TABLE IF NOT EXISTS fixture_core (id TEXT PRIMARY KEY);\n',
  );
  // 平台基建迁移：引擎「有文件才建账本表 unself_migrations_platform」（storage-tiers 等断言它存在）
  await writeFile(
    join(dir, 'migrations', 'modules', '0001_module_kv.sql'),
    'CREATE TABLE IF NOT EXISTS fixture_platform (id TEXT PRIMARY KEY);\n',
  );
  return dir;
}
