// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_STATUS, errorBody, versionConflict, type ErrorCode } from '../src/errors';

/**
 * 错误形状是前后端唯一约定的机器接口（#358 §6）：
 * 形状飘一个字段，前端「覆盖 / 重载 / 取消」三个动作就全部失效。
 */
describe('错误形状（契约 §6）', () => {
  it('每个错误码都有确定状态码，且与契约表一致', () => {
    const expected: Record<ErrorCode, number> = {
      [ERROR_CODES.missingBearerToken]: 401,
      [ERROR_CODES.tokenInvalid]: 401,
      [ERROR_CODES.jwksUnavailable]: 503,
      [ERROR_CODES.invalidRequest]: 400,
      [ERROR_CODES.notFound]: 404,
      [ERROR_CODES.forbidden]: 403,
      [ERROR_CODES.versionConflict]: 409,
      [ERROR_CODES.notImplemented]: 501,
    };
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_STATUS[code]).toBe(expected[code]);
    }
  });

  it('常规错误体只有 error 一个键（不夹带人话文案）', () => {
    const body = errorBody(ERROR_CODES.notFound);
    expect(body).toEqual({ error: 'not_found' });
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('409 体形如 { error: version_conflict, current } 且 current 原样透传', () => {
    const doc = { id: 'doc-1', version: 7 };
    const body = versionConflict(doc);
    expect(body.error).toBe('version_conflict');
    expect(body.current).toBe(doc);
    expect(Object.keys(body).sort()).toEqual(['current', 'error']);
  });
});
