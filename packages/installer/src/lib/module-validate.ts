// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `unself module validate`（docs/modules.md §7，issue #270）：
 * 对本地模块目录跑发布前六类硬检查——**检查逻辑全在 `@unself/contracts`**
 * （`validateModulePackage`，#243），这里只负责读盘（manifest / migrations / LICENSE / worker.js）
 * 与把诊断组织成 CLI 输出形状。
 *
 * 零引擎依赖（与 `module pack` 的 CLI 约束一致）；contracts 作为类型/库运行期载入。
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidateDiagnostic, ValidateResult } from '@unself/contracts';

export interface ModuleValidateResult extends ValidateResult {
  /** manifest 里的 id（可解析时）。 */
  id?: string;
  /** manifest 里的 version（可解析时）。 */
  version?: string;
}

/** 读目录下 `*.sql`（文件名 → 文本；不存在 → 空对象）。 */
async function readSqlDir(dir: string): Promise<Record<string, string>> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    out[name] = await readFile(join(dir, name), 'utf8');
  }
  return out;
}

/** 迁移文件两种布局：包根 `migrations/*.sql` 或 `migrations/<模块id>/*.sql`（docs/modules.md §2）。 */
async function readMigrations(dir: string): Promise<Record<string, string>> {
  const direct = await readSqlDir(join(dir, 'migrations'));
  if (Object.keys(direct).length > 0) return direct;
  const root = join(dir, 'migrations');
  if (!existsSync(root)) return {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = await readSqlDir(join(root, entry.name));
    if (Object.keys(sub).length > 0) return sub;
  }
  return {};
}

/** 诊断 → 单行人话（CLI 输出；check 前缀便于对照 §7 六类）。 */
export function formatValidateDiagnostic(d: ValidateDiagnostic): string {
  return `[${d.level}] ${d.check}: ${d.message}`;
}

/**
 * 校验一个模块目录（发布前自检）。
 * 读不到 manifest 直接抛人话错；其余问题一律走诊断流（errors 非空 = 不通过）。
 */
export async function validateModuleDir(dir: string): Promise<ModuleValidateResult> {
  const jsonPath = join(dir, 'manifest.json');
  const yamlPath = join(dir, 'manifest.yaml');
  if (!existsSync(jsonPath) && !existsSync(yamlPath)) {
    throw new Error(`模块目录缺 manifest：${dir}（需 manifest.json 或 manifest.yaml，docs/modules.md §2）`);
  }
  const manifestText = await readFile(existsSync(jsonPath) ? jsonPath : yamlPath, 'utf8');
  const migrations = await readMigrations(dir);
  const licenseText = existsSync(join(dir, 'LICENSE')) ? await readFile(join(dir, 'LICENSE'), 'utf8') : undefined;
  const workerText = existsSync(join(dir, 'worker.js')) ? await readFile(join(dir, 'worker.js'), 'utf8') : undefined;

  const { validateModulePackage, manifestFromYamlText } = await import('@unself/contracts');
  const result = validateModulePackage({
    manifestText,
    migrations,
    ...(licenseText !== undefined ? { licenseText } : {}),
    ...(workerText !== undefined ? { workerText } : {}),
  });

  let id: string | undefined;
  let version: string | undefined;
  try {
    const raw = (manifestText.trim().startsWith('{')
      ? JSON.parse(manifestText)
      : manifestFromYamlText(manifestText)) as { id?: unknown; version?: unknown };
    if (typeof raw.id === 'string') id = raw.id;
    if (typeof raw.version === 'string') version = raw.version;
  } catch {
    // manifest 解析失败已在 result.errors 里（schema 诊断）；输出层不再重复
  }
  return { ...result, ...(id !== undefined ? { id } : {}), ...(version !== undefined ? { version } : {}) };
}
