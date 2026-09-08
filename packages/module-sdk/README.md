# @unself/module-sdk

M0 模块 SDK 骨架：客户端消息协议（ready/token/navigate/notify/theme）、上下文解码（decodeContext）与模块后端 token 校验（verifyModuleToken）。

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
