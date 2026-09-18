// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  echoPathline,
  pathline,
  requireVisible,
  trailingPathline,
} from '../src/lib/pathline';

describe('pathline', () => {
  it('渲染唯一模板：实例目录：<path>', () => {
    expect(pathline('/srv/demo/unself')).toBe('实例目录：/srv/demo/unself');
  });
});

describe('echoPathline', () => {
  it('输出两行且等值（首行 + 操作结束后重复）', () => {
    const lines: string[] = [];
    echoPathline('/srv/demo/unself', (line) => lines.push(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('实例目录：/srv/demo/unself');
    expect(lines[1]).toBe(lines[0]);
  });
});

describe('trailingPathline', () => {
  it('返回等值两元素', () => {
    const [a, b] = trailingPathline('/srv/demo/unself');
    expect(a).toBe('实例目录：/srv/demo/unself');
    expect(b).toBe(a);
    expect(trailingPathline('/x')).toEqual(['实例目录：/x', '实例目录：/x']);
  });
});

describe('requireVisible', () => {
  it('text 含 pathline → 通过', () => {
    const p = '/srv/demo/unself';
    expect(() => requireVisible(`done\n${pathline(p)}`, p)).not.toThrow();
  });

  it('text 缺 pathline → Error（防静默丢路径）', () => {
    const p = '/srv/demo/unself';
    expect(() => requireVisible('done, no path here', p)).toThrowError(/路径可见性被破坏/);
    // 路径变了也不算可见
    expect(() => requireVisible(pathline('/other/unself'), p)).toThrowError();
  });
});
