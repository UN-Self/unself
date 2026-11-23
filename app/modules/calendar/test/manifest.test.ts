// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';

import { ModuleManifestSchema, manifestFromYamlText } from '@unself/contracts';
import { describe, expect, it } from 'vitest';

import { loadModuleManifest } from '../src/manifest';

describe('calendar manifest', () => {
  it('声明 worker 与 node 运行体（Docker 是分发形式不是运行体），本地走 connect', () => {
    const manifest = ModuleManifestSchema.parse(
      manifestFromYamlText(readFileSync('manifest.yaml', 'utf8')),
    );

    expect(manifest.id).toBe('calendar');
    expect(manifest.runtimes).toEqual(['worker', 'node']);
    expect(manifest.storage).toEqual({ accepts: ['core'], preferred: 'core' });
    expect('entry' in manifest).toBe(false);
  });

  it('运行时清单加载器能从包内 manifest 读到同一份数据', async () => {
    const manifest = await loadModuleManifest();
    expect(manifest?.id).toBe('calendar');
    expect(manifest?.version).toBe('0.1.0');
  });
});
