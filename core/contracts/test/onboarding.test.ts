// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  assertInviteTransition,
  CreateMailAccountInputSchema,
  CreateMailAccountOutputSchema,
  InviteSchema,
  NotificationSchema,
  ResetMailAccountPasswordInputSchema,
} from '../src/index';

describe('MailProvisioner schemas', () => {
  it('parses the account creation and password reset inputs used by onboarding', () => {
    expect(CreateMailAccountInputSchema.parse({ emailPrefix: 'alice', displayName: 'Alice' })).toEqual({
      emailPrefix: 'alice',
      displayName: 'Alice',
    });
    expect(CreateMailAccountOutputSchema.parse({ email: 'alice@example.com' })).toEqual({
      email: 'alice@example.com',
    });
    expect(ResetMailAccountPasswordInputSchema.parse({ email: 'alice@example.com', password: 'secret' })).toEqual({
      email: 'alice@example.com',
      password: 'secret',
    });
  });
});

describe('Invite contract', () => {
  it('parses a pending one-time invitation', () => {
    expect(
      InviteSchema.parse({
        tokenHash: 'sha256:token',
        status: 'pending',
        personalEmail: 'alice@personal.example',
        emailPrefix: 'alice',
        displayName: 'Alice',
        createdAt: '2026-09-10 10:00:00',
        expiresAt: '2026-09-17 10:00:00',
      }),
    ).toMatchObject({ status: 'pending', emailPrefix: 'alice' });
  });

  it('allows onboarding to move a pending invitation to approval', () => {
    expect(() => assertInviteTransition('pending', 'approved')).not.toThrow();
  });

  it('rejects an illegal invitation state rollback', () => {
    expect(() => assertInviteTransition('approved', 'pending')).toThrow(
      'Invalid invite transition: approved -> pending',
    );
  });
});

describe('Notification contract', () => {
  it('allows a notification to wait on the invited email before a user exists', () => {
    expect(
      NotificationSchema.parse({
        id: 'n_1',
        userId: null,
        invitedEmail: 'alice@personal.example',
        type: 'account_ready',
        payload: { activationUrl: 'https://team.example/activate' },
        isRead: false,
        createdAt: '2026-09-10 10:00:00',
      }),
    ).toMatchObject({ userId: null, invitedEmail: 'alice@personal.example' });
  });
});
