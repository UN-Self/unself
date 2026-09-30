// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FILES 统一来源解析（#310）行为测试：三来源 + 不静默回退。
 * 只测 resolveFilesSource 的落点口径与显式失败，不碰网络。
 */
import { describe, expect, it } from 'vitest';

import {
  filesSourceVars,
  moduleFilesBucket,
  resolveFilesSource,
  resolveS3Credentials,
  S3_ACCESS_KEY_ENV,
  S3_SECRET_KEY_ENV,
} from '../../src/engine/files-source';
import type { UnselfConfig } from '../../src/engine/config';
import type { StorageLevel } from '../../src/engine/migrate';

function config(storage: UnselfConfig['storage']): UnselfConfig {
  return { domain: '', modules: [], storage };
}

const R2 = { provider: 'r2', bucket: 'unself-storage' } as const;
const S3 = {
  provider: 's3',
  endpoint: 'https://s3.example.com',
  bucket: 'my-bucket',
  region: 'us-east-1',
} as const;

function resolve(level: StorageLevel, storage: UnselfConfig['storage']) {
  return resolveFilesSource({ config: config(storage), moduleId: 'chat', level });
}

describe('resolveFilesSource（#310 三来源）', () => {
  it('r2 + shared → 共享实例桶', () => {
    expect(resolve('shared', R2)).toEqual({ kind: 'r2', binding: 'FILES', origin: 'instance', bucket: 'unself-storage' });
  });

  it('r2 + dedicated → 模块独立桶', () => {
    expect(resolve('dedicated', R2)).toEqual({
      kind: 'r2',
      binding: 'FILES',
      origin: 'module',
      bucket: moduleFilesBucket('chat'),
    });
  });

  it('provider=s3 → 自备 S3 参数（与落点无关）', () => {
    expect(resolve('shared', S3)).toEqual({
      kind: 's3',
      binding: 'FILES',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'my-bucket',
    });
    expect(resolve('dedicated', S3).kind).toBe('s3');
  });

  it('core/external 落点没有对象存储通道 → 显式失败，不回退', () => {
    expect(() => resolve('core', R2)).toThrow(/没有对象存储通道/);
    expect(() => resolve('external', R2)).toThrow(/没有对象存储通道/);
  });

  it('既有 dedicated 实例（旧 lock 有模块桶）：provider=s3 也保留模块 R2 落点（#310 升级兼容）', () => {
    const preserved = resolveFilesSource({
      config: config(S3),
      moduleId: 'chat',
      level: 'dedicated',
      existingModuleBucket: true,
    });
    expect(preserved).toEqual({ kind: 'r2', binding: 'FILES', origin: 'module', bucket: moduleFilesBucket('chat') });
  });

  it('无旧模块桶的新装：provider=s3 才走 S3（新选择只对新装/显式切换生效）', () => {
    const fresh = resolveFilesSource({ config: config(S3), moduleId: 'chat', level: 'dedicated' });
    expect(fresh.kind).toBe('s3');
  });

  it('filesSourceVars：仅自备 S3 注入 FILES_S3_* vars', () => {
    expect(filesSourceVars(resolve('shared', R2))).toEqual({});
    expect(filesSourceVars(resolve('shared', S3))).toEqual({
      FILES_S3_ENDPOINT: 'https://s3.example.com',
      FILES_S3_REGION: 'us-east-1',
      FILES_S3_BUCKET: 'my-bucket',
    });
  });
});

describe('resolveS3Credentials（#310 凭据不落 config/lock）', () => {
  it('环境变量齐全 → 返回凭据', () => {
    const env = { [S3_ACCESS_KEY_ENV]: 'AK', [S3_SECRET_KEY_ENV]: 'SK' } as NodeJS.ProcessEnv;
    expect(resolveS3Credentials(env)).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' });
  });

  it('缺任一 → 显式失败（不静默渲染空凭据）', () => {
    expect(() => resolveS3Credentials({} as NodeJS.ProcessEnv)).toThrow(new RegExp(S3_ACCESS_KEY_ENV));
    expect(() => resolveS3Credentials({ [S3_ACCESS_KEY_ENV]: 'AK' } as NodeJS.ProcessEnv)).toThrow(
      new RegExp(S3_SECRET_KEY_ENV),
    );
  });
});
