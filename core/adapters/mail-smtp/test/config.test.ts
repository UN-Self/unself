// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createMailSenderFromConfig } from '../src/config';
import type { MailConfig } from '../src/config';

describe('createMailSenderFromConfig', () => {
  const complete: MailConfig = {
    host: 'mail.example.com',
    port: 465,
    username: 'no-reply@example.com',
    password: 'secret',
    from: 'no-reply@example.com',
  };

  it('完整 mail 段 → 返回 sender（非 null）', () => {
    expect(createMailSenderFromConfig(complete)).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['缺 host', { ...complete, host: undefined }],
    ['缺 port', { ...complete, port: undefined }],
    ['port 为 0', { ...complete, port: 0 }],
    ['port 为字符串', { ...complete, port: '465' }],
    ['缺 username', { ...complete, username: undefined }],
    ['缺 password', { ...complete, password: undefined }],
    ['缺 from', { ...complete, from: undefined }],
    ['from 为空串', { ...complete, from: '' }],
  ] as Array<[string, MailConfig | null | undefined]>)(
    '段缺失/不完整（%s）→ 返回 null（静默降级，不抛错）',
    (_label, cfg) => {
      expect(() => createMailSenderFromConfig(cfg)).not.toThrow();
      expect(createMailSenderFromConfig(cfg)).toBeNull();
    },
  );
});
