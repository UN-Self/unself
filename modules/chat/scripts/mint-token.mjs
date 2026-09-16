#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// #217 dev 自测签发脚本（dev-only，不进 worker bundle）：
// 生成/复用 ES256 keypair → 打印 CORE_JWKS_JSON（贴进 .dev.vars）与指定 sub/name 的 10 分钟模块 token（aud=chat）。
// 形状对齐 core 签发侧 services/core-api/src/token.ts issueModuleToken（ES256 + RFC7638 kid；10 分钟时效）。
// 用法：node scripts/mint-token.mjs [--sub <core用户id>] [--name <展示名>] [--iss <issuer>]
//   （不带参数时 sub=1；keypair 缓存在 scripts/.mint-token-keys.json，删除即重新生成）
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { readFile, writeFile } from 'node:fs/promises';

const KEY_STORE = new URL('./.mint-token-keys.json', import.meta.url);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sub') out.sub = argv[++i];
    if (argv[i] === '--name') out.name = argv[++i];
    if (argv[i] === '--iss') out.iss = argv[++i];
  }
  return out;
}

async function loadOrCreateKeyPair() {
  try {
    const stored = JSON.parse(await readFile(KEY_STORE, 'utf8'));
    const publicKey = await importJWK(stored.publicJwk, 'ES256');
    const privateKey = await importJWK(stored.privateJwk, 'ES256');
    return { publicJwk: stored.publicJwk, privateKey };
  } catch {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    await writeFile(KEY_STORE, JSON.stringify({ publicJwk, privateJwk: await exportJWK(privateKey) }));
    return { publicJwk, privateKey };
  }
}

const args = parseArgs(process.argv.slice(2));
const { publicJwk, privateKey } = await loadOrCreateKeyPair();
const kid = await calculateJwkThumbprint(publicJwk);
const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] });

const token = await new SignJWT({
  iss: args.iss || 'unself-core',
  sub: args.sub || '1',
  aud: 'chat',
  ...(args.name ? { name: args.name } : {})
})
  .setProtectedHeader({ alg: 'ES256', kid })
  .setIssuedAt()
  .setExpirationTime('10m')
  .sign(privateKey);

console.log('# .dev.vars（勿入库）：');
console.log(`CORE_JWKS_JSON='${jwks}'`);
console.log(`# 模块 token（sub=${args.sub || '1'}，aud=chat，10 分钟有效）：`);
console.log(token);
