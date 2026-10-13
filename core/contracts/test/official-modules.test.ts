// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ModuleManifestSchema } from '../src/manifest';
import { manifestFromYamlText } from '../src/validate';
import { tableNamesFromSql, validateModulePackage } from '../src/validate';
import { findRepoRoot } from './helpers/repo-root';

/** 仓库根（core/contracts → 上两级）。 */
const REPO_ROOT = findRepoRoot();

/** 官方模块包输入（worker 入口 = 模块源入口；LICENSE 取仓库根，官方同源分发）。 */
function officialInput(moduleId: 'hello' | 'chat'): Parameters<typeof validateModulePackage>[0] {
  const manifestYaml = readFileSync(join(REPO_ROOT, 'app', 'modules', moduleId, 'manifest.yaml'), 'utf8');
  const input: Parameters<typeof validateModulePackage>[0] = {
    manifestText: manifestYaml, // YAML 直接入（validate 内部走 manifestFromYamlText）
    packageName: moduleId,
    workerText: readFileSync(
      join(
        REPO_ROOT,
        'app',
        'modules',
        moduleId,
        moduleId === 'hello' ? 'src/index.ts' : 'worker/src/index.js',
      ),
      'utf8',
    ),
    licenseText: readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8'),
  };
  if (moduleId === 'chat') {
    input.migrations = {};
    for (const family of ['chat', 'chat-shared']) {
      const directory = join(REPO_ROOT, 'app', 'modules', 'chat', 'migrations', family);
      for (const file of readdirSync(directory).filter((name) => name === '0001_baseline.sql' || name === '0004_message_deletion_audit.sql' || name === '0005_message_blocks.sql').sort()) {
        input.migrations[`${family}/${file}`] = readFileSync(join(directory, file), 'utf8');
      }
    }
  }
  return input;
}

describe('官方模块迁移到契约 v1 并通过 validate（验收①）', () => {
  it('hello manifest.yaml 过 ModuleManifestSchema（新字段：runtimes/permissions，无 requires/capabilities）', () => {
    const text = readFileSync(join(REPO_ROOT, 'app', 'modules', 'hello', 'manifest.yaml'), 'utf8');
    const manifest = ModuleManifestSchema.parse(manifestFromYamlText(text));
    expect(manifest.id).toBe('hello');
    expect(manifest.runtimes).toEqual(['worker']);
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.storage).toBeUndefined(); // 省略 = 只支持 core
  });

  it('hello 通过 validate（真实文件：manifest.yaml + LICENSE + worker 入口）', () => {
    const result = validateModulePackage(officialInput('hello'));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('chat manifest.yaml 过 ModuleManifestSchema（shared+dedicated，tables 20 / tablesShared 20）', () => {
    const text = readFileSync(join(REPO_ROOT, 'app', 'modules', 'chat', 'manifest.yaml'), 'utf8');
    const manifest = ModuleManifestSchema.parse(manifestFromYamlText(text));
    expect(manifest.storage?.accepts).toEqual(['shared', 'dedicated']);
    expect(manifest.storage?.preferred).toBe('dedicated');
    expect(manifest.tables).toHaveLength(21);
    expect(manifest.tablesShared).toHaveLength(21);
    expect(manifest.tablesShared?.every((t) => t.startsWith('chat_'))).toBe(true);
    expect(manifest.permissions).toEqual(['storage', 'notify']);
  });

  it('chat 通过 validate：tables/tablesShared 与两套迁移实际建表逐一一致（真实文件）', () => {
    const input = officialInput('chat');
    const result = validateModulePackage(input);
    // 迁移链全部纳入校验：新表通过独立迁移加入，不能只看 0001 基线。
    const dedicatedSql = Object.entries(input.migrations ?? {})
      .filter(([name]) => name.startsWith('chat/'))
      .map(([, sql]) => sql).join('\n');
    const sharedSql = Object.entries(input.migrations ?? {})
      .filter(([name]) => name.startsWith('chat-shared/'))
      .map(([, sql]) => sql).join('\n');
    expect(tableNamesFromSql(dedicatedSql)).toHaveLength(21);
    expect(tableNamesFromSql(sharedSql)).toHaveLength(21);
    expect(tableNamesFromSql(sharedSql).every((t) => t.startsWith('chat_'))).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
