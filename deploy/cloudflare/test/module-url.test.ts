// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块可达 URL 形态决策（#273）纯函数行为测试：
 * domain 形态 → zone 路径 `/m/<id>`；workers.dev 形态 → 模块自有子域。
 * 这是注册表 entry / iframe 装载 / ⑨冒烟 / 主题体检四处共用的唯一真值源。
 */
import { describe, expect, it } from 'vitest';
import {
  moduleBaseUrl,
  moduleEntryUrl,
  moduleHealthUrl,
  moduleRoutePattern,
  mountShapeOf,
  originOf,
  parseWorkersDevSubdomain,
} from '../src/module-url';

const CORE_WORKER = 'unself-core-api';

describe('mountShapeOf（形态判定）', () => {
  it('domain 非空 → domain；空串/空白/undefined → workers-dev', () => {
    expect(mountShapeOf('demo.handywote.top')).toBe('domain');
    expect(mountShapeOf('')).toBe('workers-dev');
    expect(mountShapeOf('   ')).toBe('workers-dev');
    expect(mountShapeOf(undefined)).toBe('workers-dev');
  });
});

describe('moduleBaseUrl / moduleEntryUrl（模块真实挂载根）', () => {
  it('domain 形态：zone 路径 `/m/<id>`，entry 带尾斜杠', () => {
    const input = {
      domain: 'demo.handywote.top',
      workersDevSubdomain: null,
      moduleId: 'hello',
      moduleWorkerName: 'unself-module-hello',
    };
    expect(moduleBaseUrl(input)).toBe('https://demo.handywote.top/m/hello');
    expect(moduleEntryUrl(input)).toBe('https://demo.handywote.top/m/hello/');
  });

  it('workers.dev 形态：模块自有子域根（不拼 /m/<id>）', () => {
    const input = {
      domain: '',
      workersDevSubdomain: 'test-subdomain',
      moduleId: 'hello',
      moduleWorkerName: 'unself-module-hello',
    };
    expect(moduleBaseUrl(input)).toBe('https://unself-module-hello.test-subdomain.workers.dev');
    expect(moduleEntryUrl(input)).toBe('https://unself-module-hello.test-subdomain.workers.dev/');
  });

  it('workers.dev 形态缺账号子域 → 抛错（不回落 core URL 造成「不可达但看起来跑了」）', () => {
    expect(() =>
      moduleBaseUrl({
        domain: '',
        workersDevSubdomain: null,
        moduleId: 'hello',
        moduleWorkerName: 'unself-module-hello',
      }),
    ).toThrow(/workers\.dev 形态无法解析账号子域/);
  });
});

describe('moduleRoutePattern / moduleHealthUrl', () => {
  it('zone 路由 pattern 只在 domain 形态使用', () => {
    expect(moduleRoutePattern('demo.handywote.top', 'hello')).toBe('demo.handywote.top/m/hello/*');
  });

  it('health URL = 模块挂载根 + /api/health（容忍尾斜杠）', () => {
    expect(moduleHealthUrl('https://demo.handywote.top/m/hello')).toBe('https://demo.handywote.top/m/hello/api/health');
    expect(moduleHealthUrl('https://demo.handywote.top/m/hello/')).toBe('https://demo.handywote.top/m/hello/api/health');
  });
});

describe('parseWorkersDevSubdomain（从 core URL 反解账号子域，避免二次 API 请求）', () => {
  it('标准 core workers.dev URL → 子域', () => {
    expect(
      parseWorkersDevSubdomain('https://unself-core-api.test-subdomain.workers.dev', CORE_WORKER),
    ).toBe('test-subdomain');
  });

  it('自带域 / 非 https / 名字不匹配 / 坏 URL → null', () => {
    expect(parseWorkersDevSubdomain('https://demo.handywote.top', CORE_WORKER)).toBeNull();
    expect(parseWorkersDevSubdomain('http://unself-core-api.test-subdomain.workers.dev', CORE_WORKER)).toBeNull();
    expect(parseWorkersDevSubdomain('https://other.example.workers.dev', CORE_WORKER)).toBeNull();
    expect(parseWorkersDevSubdomain('not a url', CORE_WORKER)).toBeNull();
  });
});

describe('originOf（frame-ancestors 值 = 壳 origin）', () => {
  it('取 origin，丢掉路径', () => {
    expect(originOf('https://unself-core-api.test-subdomain.workers.dev')).toBe(
      'https://unself-core-api.test-subdomain.workers.dev',
    );
    expect(originOf('https://demo.handywote.top/m/hello')).toBe('https://demo.handywote.top');
  });
});
