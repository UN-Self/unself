// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { manifestId, moduleIds, normalizeModuleEntries, parseUnselfConfigText, stripJsonc } from '../src/config';

describe('stripJsonc', () => {
  it('剥离行注释与块注释（字符串内容不受伤）', () => {
    const src = `{
  // 行注释
  "url": "http://x/*not-a-comment*/", /* 块注释 */
  "n": 1
}`;
    const parsed = JSON.parse(stripJsonc(src)) as { url: string; n: number };
    expect(parsed.url).toBe('http://x/*not-a-comment*/');
    expect(parsed.n).toBe(1);
  });

  it('剥离尾逗号（对象与数组）', () => {
    const parsed = JSON.parse(stripJsonc('{"a":[1,2,],"b":true,}')) as { a: number[]; b: boolean };
    expect(parsed.a).toEqual([1, 2]);
    expect(parsed.b).toBe(true);
  });
});

describe('parseUnselfConfigText', () => {
  it('样例配置（domain 空 → 默认空串；storage 缺省 r2 + unself-storage）', () => {
    const cfg = parseUnselfConfigText(
      '// 头注释\n{\n "domain": "",\n "modules": [{"id":"hello","source":"npm:@unself/hello@0.1.0"}],\n}',
    );
    expect(cfg.domain).toBe('');
    expect(cfg.modules).toEqual([{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }]);
    expect(cfg.storage).toEqual({ provider: 'r2', bucket: 'unself-storage' });
  });

  it('s3 变体通过（endpoint/bucket 必填，region 默认 auto）', () => {
    const cfg = parseUnselfConfigText(
      '{"domain":"team.example.com","modules":[{"id":"chat","source":"npm:@unself/chat@0.1.0"}],"storage":{"provider":"s3","endpoint":"https://s3.example","bucket":"b"}}',
    );
    expect(cfg.storage).toEqual({ provider: 's3', endpoint: 'https://s3.example', bucket: 'b', region: 'auto' });
    expect(cfg.domain).toBe('team.example.com');
  });

  it('拒绝坏模块 id、坏 storage provider；裸字符串条目给人话迁移错（#77）', () => {
    expect(() => parseUnselfConfigText('{"modules":[{"id":"Bad_ID","source":"npm:x@1.0.0"}]}')).toThrow();
    expect(() => parseUnselfConfigText('{"modules":[{"id":"a","source":"npm:x@1.0.0"}],"storage":{"provider":"dropbox"}}')).toThrow();
    expect(() => parseUnselfConfigText('{"modules":["a"]}')).toThrow(/旧形态/);
    expect(() => parseUnselfConfigText('{"modules":["a"]}')).toThrow(/npm:@unself\/hello@0.1.0/);
  });

  it('空 modules 通过校验（全停用：storage 默认 r2/unself-storage）', () => {
    const cfg = parseUnselfConfigText('{"domain":"","modules":[]}');
    expect(cfg.modules).toEqual([]);
    expect(cfg.storage).toEqual({ provider: 'r2', bucket: 'unself-storage' });
  });
});

describe('manifestId', () => {
  it('从 manifest.yaml 取顶层 id', () => {
    const yaml = '# SPDX\nid: hello\nroute: /m/hello\nversion: 0.1.0\n';
    expect(manifestId(yaml)).toBe('hello');
  });
  it('缺 id 返回 null', () => {
    expect(manifestId('route: /m/x\n')).toBeNull();
  });
});

describe('modules 对象形态 {id, source}（#245/#77：只收对象）', () => {
  it('对象条目通过校验（官方模块也写 npm 串）', () => {
    const cfg = parseUnselfConfigText(
      '{"modules":[{"id":"hello","source":"npm:@unself/hello@0.1.0"},{"id":"todo","source":"npm:@acme/unself-todo@1.2.0"},{"id":"sync","source":"github:acme/sync#v0.3.0"}]}',
    );
    expect(cfg.modules[0]).toEqual({ id: 'hello', source: 'npm:@unself/hello@0.1.0' });
    expect(cfg.modules[1]).toEqual({ id: 'todo', source: 'npm:@acme/unself-todo@1.2.0' });
    expect(cfg.modules[2]).toEqual({ id: 'sync', source: 'github:acme/sync#v0.3.0' });
  });

  it('对象缺 source / 坏 id 拒绝', () => {
    expect(() => parseUnselfConfigText('{"modules":[{"id":"todo"}]}')).toThrow();
    expect(() => parseUnselfConfigText('{"modules":[{"id":"Todo","source":"npm:x@1.0.0"}]}')).toThrow();
  });

  it('normalizeModuleEntries：对象条目归一化为 {id, source}（source 必填）', () => {
    const cfg = parseUnselfConfigText('{"modules":[{"id":"hello","source":"npm:@unself/hello@0.1.0"},{"id":"todo","source":"file:./modules/todo"}]}');
    expect(normalizeModuleEntries(cfg.modules)).toEqual([
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
      { id: 'todo', source: 'file:./modules/todo' },
    ]);
  });

  it('normalizeModuleEntries：重复 id 拒绝', () => {
    const cfg = parseUnselfConfigText('{"modules":[{"id":"hello","source":"npm:@unself/hello@0.1.0"},{"id":"hello","source":"npm:x@1.0.0"}]}');
    expect(() => normalizeModuleEntries(cfg.modules)).toThrow(/重复模块 id/);
  });

  it('moduleIds：纯 id 提取（存量消费方视角）', () => {
    const cfg = parseUnselfConfigText('{"modules":[{"id":"a1","source":"npm:x@1.0.0"},{"id":"todo","source":"npm:@acme/todo@1.0.0"}]}');
    expect(moduleIds(normalizeModuleEntries(cfg.modules))).toEqual(['a1', 'todo']);
  });
});
