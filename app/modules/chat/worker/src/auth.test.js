// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/auth.test.js（GPL-3.0-only，裁剪版）
import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from './auth.js';

const password = 'correct horse battery staple';

test('password verification accepts the matching password and rejects another password', async () => {
  const credentials = await hashPassword(password);

  assert.equal(await verifyPassword(password, credentials.hash, credentials.salt), true);
  assert.equal(await verifyPassword(`${password}!`, credentials.hash, credentials.salt), false);
});

test('password verification rejects same-length hash changes at either edge', async () => {
  const credentials = await hashPassword(password);
  const firstReplacement = credentials.hash[0] === 'A' ? 'B' : 'A';
  const lastReplacement = credentials.hash.endsWith('A') ? 'B' : 'A';
  const changedFirst = `${firstReplacement}${credentials.hash.slice(1)}`;
  const changedLast = `${credentials.hash.slice(0, -1)}${lastReplacement}`;

  assert.equal(await verifyPassword(password, changedFirst, credentials.salt), false);
  assert.equal(await verifyPassword(password, changedLast, credentials.salt), false);
});

test('password verification rejects a hash with an unexpected length', async () => {
  const credentials = await hashPassword(password);

  assert.equal(await verifyPassword(password, credentials.hash.slice(1), credentials.salt), false);
});
