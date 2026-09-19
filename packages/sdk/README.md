# @unself/sdk

unself 模块 SDK（模块作者唯一要装的包）：模块页 ↔ core 的 postMessage 握手、模块 token 验签、
Core API 存储代理客户端与主题契约客户端。

## 安装

```sh
npm i @unself/sdk
```

唯一运行期依赖是 `jose`（JWT 验签）；契约包（`packages/contracts`）已在**构建期内联**进发布产物，
第三方无需（也不应）单独安装它。本包不要求 workspace。

## 浏览器侧资产（平台注入，不要自带）

模块页用的浏览器资产 `module-sdk.esm.js` 随本包发布，但由**平台在部署期注入**
（与 core 同版本，见 `docs/modules.md` §9）。模块页按相对路径引用：

```ts
import { createModuleSDK, resolveShellOrigin } from './sdk/module-sdk.esm.js';
```

## worker 侧用法

模块后端把本包**打进自己的 `worker.js`**（决策 #60：一切依赖 bundle 进产物，零运行时装包）：

```ts
import { createCoreApiStorage, verifyModuleToken } from '@unself/sdk';
```

## verifyModuleToken（模块后端验签，§5.2 B 方案）

```ts
verifyModuleToken(token, {
  coreJwksJson: string, // Core GET /.well-known/jwks.json 响应体 JSON 序列化（部署期注入 vars，零运行时网络）
  audience: string,     // 期望 audience（= 模块 id；aud 锁定防跨模块重放）
})
```

内部 `createLocalJWKSet(JSON.parse(coreJwksJson))` + `jwtVerify(token, jwks, { audience })`，
再经 `ModuleTokenClaimsSchema.parse` 解析；返回 `ModuleTokenClaims`。
audience 不匹配、签名失败或 claims 形状不符均抛错（调用方回 401）。

## 开发（本仓库内）

```sh
pnpm --filter @unself/sdk build     # 产出 dist/（包入口 + .d.ts + 浏览器 ESM/IIFE 资产）
pnpm --filter @unself/sdk test      # 行为测试
pnpm --filter @unself/sdk typecheck
```

浏览器侧资产是**单一真源**：安装器装配只从 `dist/` 复制（issue #283），不二次构建。
