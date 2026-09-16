// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createKeypair,
  detectExistingSecret,
  detectWorkerSecret,
  JWT_SECRET_NAME,
  publicJwksJson,
  putWorkerSecret,
} from '../src/keypair';
import type { Wrangler } from '../src/wrangler';

/** 录制型 fake：只模拟 secret list / secret put 的账户状态。 */
function makeFake(options?: { secrets?: string[] }) {
  const state = {
    secrets: new Set(options?.secrets ?? []),
    putLog: [] as Array<{ secret: string; worker: string; value: string }>,
    commands: [] as string[],
  };
  const exec = async (args: string[]) => {
    state.commands.push(args.join(' '));
    const [cmd, sub] = args;
    if (cmd === 'secret' && sub === 'list') {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify([...state.secrets].map((name) => ({ name }))),
        stderr: '',
      };
    }
    return { ok: true, code: 0, stdout: 'Success', stderr: '' };
  };
  const wrangler: Wrangler = {
    run: exec,
    tryRun: exec,
  };
  return { wrangler, state };
}

describe('detectWorkerSecret（#219：按 secret 名探测，chat 密钥环复用）', () => {
  it('JWT_PRIVATE_KEY 在场 → true；缺省名行为与 detectExistingSecret 一致', async () => {
    const fake = makeFake({ secrets: ['JWT_PRIVATE_KEY'] });
    await expect(detectWorkerSecret(fake.wrangler, 'unself-core-api')).resolves.toBe(true);
    await expect(detectExistingSecret(fake.wrangler, 'unself-core-api')).resolves.toBe(true);
  });

  it('指定名探测只看该名：chat 密钥环在场而 JWT 缺失 → chat true / JWT false', async () => {
    const fake = makeFake({ secrets: ['EDGECHAT_ENCRYPTION_KEYRING'] });
    await expect(
      detectWorkerSecret(fake.wrangler, 'unself-module-chat', 'EDGECHAT_ENCRYPTION_KEYRING'),
    ).resolves.toBe(true);
    await expect(
      detectWorkerSecret(fake.wrangler, 'unself-module-chat', JWT_SECRET_NAME),
    ).resolves.toBe(false);
  });

  it('输出带日志前缀（取最后一个 [ 起）与空列表 → 容忍解析', async () => {
    const fake = makeFake();
    fake.wrangler.tryRun = async () => ({
      ok: true,
      code: 0,
      stdout: '⛅️ wrangler v4.129.0\n[]',
      stderr: '',
    });
    await expect(detectWorkerSecret(fake.wrangler, 'w', 'ANY')).resolves.toBe(false);
  });

  it('非零退出（Worker 不存在）→ 视为缺失不抛错', async () => {
    const fake = makeFake();
    fake.wrangler.tryRun = async () => ({ ok: false, code: 1, stdout: '', stderr: 'worker not found' });
    await expect(detectWorkerSecret(fake.wrangler, 'ghost', 'ANY')).resolves.toBe(false);
  });
});

describe('putWorkerSecret（#219：按 secret 名写入）', () => {
  it('真实 spawn：argv 含 secret put <名> --name <worker>，值经 stdin 管道到达', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unself-secret-'));
    // 假 wrangler：记录 argv 与 stdin（子进程 cwd=dir，相对路径落在临时目录），回成功退出
    await writeFile(
      join(dir, 'wrangler'),
      '#!/bin/sh\ncat > stdin.txt\nprintf "%s\\n" "$@" > argv.txt\n',
      { mode: 0o755 },
    );
    await putWorkerSecret(
      join(dir, 'wrangler'),
      dir,
      'unself-module-chat',
      'KEYRING-VALUE',
      'EDGECHAT_ENCRYPTION_KEYRING',
      () => {},
    );
    const argv = await readFile(join(dir, 'argv.txt'), 'utf8');
    expect(argv.split('\n').filter(Boolean)).toEqual([
      'secret',
      'put',
      'EDGECHAT_ENCRYPTION_KEYRING',
      '--name',
      'unself-module-chat',
    ]);
    expect(await readFile(join(dir, 'stdin.txt'), 'utf8')).toBe('KEYRING-VALUE');
    await rm(dir, { recursive: true, force: true });
  });

  it('缺省 secret 名 = JWT_PRIVATE_KEY 契约（既有调用面不变形）', () => {
    expect(JWT_SECRET_NAME).toBe('JWT_PRIVATE_KEY');
  });
});

describe('createKeypair / publicJwksJson（既有行为回归）', () => {
  it('生成的密钥对能产出合法 JWKS（kty/crv/kid/use/alg 齐全）', async () => {
    const pair = await createKeypair();
    const jwks = JSON.parse(publicJwksJson(pair)) as { keys: Array<Record<string, string>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' });
    expect(jwks.keys[0]!.kid).toBe(pair.kid);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });
});
