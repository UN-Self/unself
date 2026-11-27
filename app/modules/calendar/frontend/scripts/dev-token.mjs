// SPDX-License-Identifier: AGPL-3.0-only
/** 本地联调签发脚本：复用或生成 ES256 密钥、写模块 .dev.vars、打印 token；参数 --rotate / --ttl / --sub / --name，产物不入库。 */
import { createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = join(HERE, '.dev-keys.json');
const VARS_FILE = join(HERE, '..', '..', '.dev.vars');

const ISSUER = 'dev-core';
const AUDIENCE = 'calendar';
const KID = 'dev-1';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function loadOrCreateKeys(rotate) {
  if (!rotate && existsSync(KEY_FILE)) {
    return JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const record = {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
  writeFileSync(KEY_FILE, `${JSON.stringify(record, null, 2)}\n`)
  return record;
}

function toJwks(publicJwk) {
  return {
    keys: [
      {
        kty: 'EC',
        crv: 'P-256',
        x: publicJwk.x,
        y: publicJwk.y,
        alg: 'ES256',
        use: 'sig',
        kid: KID,
      },
    ],
  };
}

function signToken(privateJwk, { sub, name, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid: KID };
  const payload = {
    iss: ISSUER,
    sub,
    aud: AUDIENCE,
    iat: now,
    exp: now + ttlSeconds,
    name,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const signature = createSign('SHA256')
    .update(signingInput)
    .end()
    .sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

function parseArgs(argv) {
  const out = { rotate: false, sub: 'dev-u1', name: '联调用户A', ttl: 86400 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rotate') out.rotate = true;
    else if (arg === '--sub') out.sub = argv[(i += 1)];
    else if (arg === '--name') out.name = argv[(i += 1)];
    else if (arg === '--ttl') out.ttl = Number(argv[(i += 1)]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const keys = loadOrCreateKeys(args.rotate);
const jwksJson = JSON.stringify(toJwks(keys.publicJwk));

// .dev.vars 是 dotenv 格式（单引号包裹）；内容没变就不写，避免 wrangler dev 反复重启
const varsContent = [`CORE_JWKS_JSON='${jwksJson}'`, `CORE_ISSUER=${ISSUER}`, ''].join('\n');
const varsChanged =
  !existsSync(VARS_FILE) || readFileSync(VARS_FILE, 'utf8') !== varsContent;
if (varsChanged) writeFileSync(VARS_FILE, varsContent);

const token = signToken(keys.privateJwk, {
  sub: args.sub,
  name: args.name,
  ttlSeconds: args.ttl,
});

console.log(varsChanged ? `已写 ${VARS_FILE}` : `${VARS_FILE} 内容未变，跳过写入`);
console.log(`身份 sub=${args.sub} name=${args.name} 有效期 ${args.ttl}s`);
console.log('');
console.log('token:');
console.log(token);
console.log('');
console.log('浏览器联调地址（dev-shim 会把这段 token 下发给模块页）：');
console.log(`http://localhost:5175/dev-shim.html?token=${token}`);
console.log('');
console.log('命令行直测：');
console.log(`curl -H "Authorization: Bearer ${token}" http://127.0.0.1:8787/api/health`);
