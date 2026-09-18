// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInstanceDir, instanceLayout, INSTANCE_DIR_NAME, loadInstance } from '../src/lib/dir';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unself-dir-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('instanceLayout', () => {
  it('按决策 #53 布局拼路径', () => {
    const layout = instanceLayout('/srv/demo');
    expect(layout.instanceDir).toBe(join('/srv/demo', INSTANCE_DIR_NAME));
    expect(layout.configPath).toBe(join(layout.instanceDir, 'unself.config.jsonc'));
    expect(layout.lockPath).toBe(join(layout.instanceDir, 'unself.lock'));
    expect(layout.generatedDir).toBe(join(layout.instanceDir, 'generated'));
  });
});

describe('createInstanceDir', () => {
  it('首跑生成 config（默认 modules=["hello"]）、lock 骨架与 generated 目录', () => {
    const res = createInstanceDir(root);
    expect(res.configCreated).toBe(true);
    expect(res.lockCreated).toBe(true);

    const config = readFileSync(res.layout.configPath, 'utf8');
    expect(config).toContain('SPDX-License-Identifier: AGPL-3.0-only');
    expect(config).toContain('"domain": ""');
    expect(config).toContain('"modules": ["hello"]');
    expect(config).toContain('"provider": "r2"');

    const lock = JSON.parse(readFileSync(res.layout.lockPath, 'utf8')) as Record<string, unknown>;
    expect(lock).toEqual({ lockVersion: 1, instance: {}, modules: [] });
  });

  it('opts.modules 覆盖默认模块列表', () => {
    const res = createInstanceDir(root, { modules: ['notes'] });
    expect(readFileSync(res.layout.configPath, 'utf8')).toContain('"modules": ["notes"]');
  });

  it('幂等：二跑不覆盖用户手改的 config 与已有 lock', () => {
    createInstanceDir(root);
    const layout = instanceLayout(root);
    const handEdited = readFileSync(layout.configPath, 'utf8').replace(
      '"domain": ""',
      '"domain": "demo.example.com"',
    );
    // 模拟用户手改
    writeFileSync(layout.configPath, handEdited);

    const second = createInstanceDir(root, { modules: ['other'] });
    expect(second.configCreated).toBe(false);
    expect(second.lockCreated).toBe(false);
    expect(readFileSync(layout.configPath, 'utf8')).toBe(handEdited);
    expect(readFileSync(layout.configPath, 'utf8')).toContain('"domain": "demo.example.com"');
  });

  it('lock 骨架无秘密字段（形状秘密断言）', () => {
    const res = createInstanceDir(root);
    const raw = readFileSync(res.layout.lockPath, 'utf8');
    expect(raw).toMatch(/"lockVersion"/);
    expect(raw.toLowerCase()).not.toMatch(/secret|token|password|key/);
  });
});

describe('loadInstance', () => {
  it('目录与 config 都在 → 返回父目录名与 resolve 后路径', () => {
    createInstanceDir(root);
    const inst = loadInstance(root);
    expect(inst.name).toBe(root.split('/').pop());
    expect(inst.path.endsWith(join(INSTANCE_DIR_NAME))).toBe(true);
  });

  it('实例目录缺失 → 人话 Error 含路径', () => {
    expect(() => loadInstance(root)).toThrowError(/实例目录不存在/);
    try {
      loadInstance(root);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(root);
    }
  });

  it('config 缺失 → 人话 Error 含配置路径', () => {
    const layout = instanceLayout(root);
    mkdirSync(layout.instanceDir, { recursive: true });
    try {
      loadInstance(root);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(layout.configPath);
    }
  });
});
