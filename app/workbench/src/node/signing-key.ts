// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 实例签名私钥自举（#360）：`workbench start`（`src/cli.ts` → `startNode`）里的唯一一套，
 * 容器与裸机共用，不另造第二套。
 *
 * 优先用环境注入的 `JWT_PRIVATE_KEY`（用户自带）；否则沿用数据目录里的
 * `jwt_private_key.pem`；都没有就首启生成一份落盘（0600）——容器重建+卷保留则沿用，
 * 卷丢弃即换钥（存量会话失效，与 CF 换 secret 同语义）。
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY_FILE = 'jwt_private_key.pem';

/** 取 PEM：环境注入 > 数据目录既有文件 > 首启生成。 */
export async function resolveSigningKey(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): Promise<{ pem: string; source: 'env' | 'file' | 'generated'; path: string }> {
  const path = join(dataDir, KEY_FILE);
  if (env.JWT_PRIVATE_KEY) {
    return { pem: env.JWT_PRIVATE_KEY, source: 'env', path };
  }
  try {
    return { pem: await readFile(path, 'utf8'), source: 'file', path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dataDir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await writeFile(path, pem, { mode: 0o600 });
  await chmod(path, 0o600);
  return { pem, source: 'generated', path };
}
