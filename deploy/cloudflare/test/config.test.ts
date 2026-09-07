// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { manifestId, parseUnselfConfigText, stripJsonc } from '../src/config';

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
    const cfg = parseUnselfConfigText('// 头注释\n{\n "domain": "",\n "modules": ["hello"],\n}');
    expect(cfg.domain).toBe('');
    expect(cfg.modules).toEqual(['hello']);
    expect(cfg.storage).toEqual({ provider: 'r2', bucket: 'unself-storage' });
  });

  it('s3 变体通过（endpoint/bucket 必填，region 默认 auto）', () => {
    const cfg = parseUnselfConfigText(
      '{"domain":"team.example.com","modules":["chat"],"storage":{"provider":"s3","endpoint":"https://s3.example","bucket":"b"}}',
    );
    expect(cfg.storage).toEqual({ provider: 's3', endpoint: 'https://s3.example', bucket: 'b', region: 'auto' });
    expect(cfg.domain).toBe('team.example.com');
  });

  it('拒绝空 modules、坏模块 id、坏 storage provider', () => {
    expect(() => parseUnselfConfigText('{"modules":[]}')).toThrow();
    expect(() => parseUnselfConfigText('{"modules":["Bad_ID"]}')).toThrow();
    expect(() => parseUnselfConfigText('{"modules":["a"],"storage":{"provider":"dropbox"}}')).toThrow();
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
