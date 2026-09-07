// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

export interface Bindings {
  MODULES_DB: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>();

// M0 骨架：极简页面，向宿主（shell）自报就绪
app.get('/', (c) =>
  c.html(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>hello</title>
</head>
<body>
  <h1>hello</h1>
  <p>module skeleton (M0)</p>
  <script>
    // M0 会换成 @unself/module-sdk 的 ready()
    window.parent.postMessage({ type: 'ready' }, '*');
  </script>
</body>
</html>`)
);

app.get('/api/health', (c) => c.json({ ok: true, service: 'module-hello' }));

// M0 占位：实现 verifyModuleToken + hello_counter 表读写
app.get('/api/count', (c) =>
  c.json({ error: 'not implemented (M0 scaffold)' }, 501)
);

export default app;
