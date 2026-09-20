// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { caddySnippet, nginxSnippet, publicHostOf, reverseProxySnippets } from '../../src/engine/dns';

/**
 * 反代片段生成行为测试（#247，决策 #63「生成但不代管」）：
 * 断言打在「粘贴即生效的关键要素」——站点名/上游/无路径重写/升级头/加头提示。
 */

const INPUT = {
  publicUrl: 'https://todo.example.com',
  upstream: 'http://127.0.0.1:8080',
  shellOrigin: 'https://team.example.com',
  moduleId: 'todo',
};

describe('publicHostOf', () => {
  it('https URL → host（含非默认端口）；http/垃圾 → null', () => {
    expect(publicHostOf('https://todo.example.com/m/todo/')).toBe('todo.example.com');
    expect(publicHostOf('https://todo.example.com:8443')).toBe('todo.example.com:8443');
    expect(publicHostOf('http://todo.example.com')).toBeNull();
    expect(publicHostOf('not a url')).toBeNull();
  });
});

describe('caddySnippet', () => {
  it('站点名 = publicUrl host；上游原样；路径无重写（恒挂根路径不变式）', () => {
    const s = caddySnippet(INPUT);
    expect(s).toContain('todo.example.com {');
    expect(s).toContain('reverse_proxy http://127.0.0.1:8080');
    expect(s).not.toMatch(/handle_path|strip_prefix|rewrite/);
  });

  it('带 frame-ancestors 加头提示（#73：CSP 归模块页，片段只提示不代管）', () => {
    expect(caddySnippet(INPUT)).toContain('frame-ancestors https://team.example.com');
  });

  it('非法 publicUrl → 人话占位而非抛错', () => {
    expect(caddySnippet({ ...INPUT, publicUrl: 'http://x.example' })).toContain('未生成 Caddy 片段');
  });
});

describe('nginxSnippet', () => {
  it('server_name = host；proxy_pass 上游；WebSocket 升级头齐全', () => {
    const s = nginxSnippet(INPUT);
    expect(s).toContain('server_name todo.example.com;');
    expect(s).toContain('proxy_pass http://127.0.0.1:8080;');
    expect(s).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(s).toContain('proxy_set_header Connection "upgrade";');
    expect(s).not.toMatch(/location \/m\//);
  });

  it('非法 publicUrl → 人话占位而非抛错', () => {
    expect(nginxSnippet({ ...INPUT, publicUrl: 'nope' })).toContain('未生成 nginx 片段');
  });
});

describe('reverseProxySnippets', () => {
  it('一次给两份', () => {
    const both = reverseProxySnippets(INPUT);
    expect(both.caddy).toContain('reverse_proxy');
    expect(both.nginx).toContain('proxy_pass');
  });
});

// ---- connect 可达性体检（#247：复用冒烟 + 诚实标注）----
import { checkConnectReachability, CONNECT_REACHABILITY_NOTICE } from '../../src/engine/smoke';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('checkConnectReachability（决策 #63：安装器可达性体检）', () => {
  it('健康端点 200 + ok:true → ok 且带诚实标注', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const results = await checkConnectReachability({
        modules: [{ id: 'todo', publicUrl: `http://127.0.0.1:${port}` }],
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(true);
      expect(results[0]!.notice).toBe(CONNECT_REACHABILITY_NOTICE);
    } finally {
      server.close();
    }
  });

  it('不可达/非 200 → 该条失败但不抛；标注恒在', async () => {
    const results = await checkConnectReachability({
      modules: [{ id: 'ghost', publicUrl: 'http://127.0.0.1:9' }],
      timeoutMs: 1500,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.status).toBe(0);
    expect(results[0]!.notice).toContain('不证明用户浏览器可达');
  });
});
