// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/encryption.test.js（GPL-3.0-only，裁剪版）
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptAttachment,
  decryptMessageContent,
  encryptAttachment,
  encryptMessageContent,
  getAttachmentEnvelopeKeyId,
  getMessageEnvelopeKeyId,
  isEncryptedAttachment,
  isEncryptedMessageContent,
  loadEncryptionKeyring
} from './encryption.js';

function encodedKey(seed) {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256)).toString(
    'base64'
  );
}

function keyring(activeKeyId = 'v1') {
  return JSON.stringify({
    activeKeyId,
    keys: {
      v1: encodedKey(1),
      v2: encodedKey(101)
    }
  });
}

const messageContext = { channelId: 7, senderId: 42 };

test('message encryption round-trips unicode with randomized nonces', async () => {
  const plaintext = '服务端加密\nsecond line';
  const first = await encryptMessageContent(keyring(), plaintext, messageContext);
  const second = await encryptMessageContent(keyring(), plaintext, messageContext);

  assert.equal(isEncryptedMessageContent(first), true);
  assert.equal(getMessageEnvelopeKeyId(first), 'v1');
  assert.equal(first.includes(plaintext), false);
  assert.notEqual(first, second);
  assert.equal(await decryptMessageContent(keyring(), first, messageContext), plaintext);
});

test('message decryption keeps legacy plaintext readable', async () => {
  assert.equal(await decryptMessageContent(keyring(), 'legacy plaintext', messageContext), 'legacy plaintext');
});

test('message authentication rejects tampering and the wrong context', async () => {
  const encrypted = await encryptMessageContent(keyring(), 'authenticated', messageContext);
  const replacement = encrypted.endsWith('A') ? 'B' : 'A';
  const tampered = `${encrypted.slice(0, -1)}${replacement}`;

  await assert.rejects(
    decryptMessageContent(keyring(), tampered, messageContext),
    /authentication failed/
  );
  await assert.rejects(
    decryptMessageContent(keyring(), encrypted, { channelId: 8, senderId: 42 }),
    /authentication failed/
  );
});

test('versioned keyring decrypts old data after the active key rotates', async () => {
  const oldEnvelope = await encryptMessageContent(keyring('v1'), 'before rotation', messageContext);
  const newEnvelope = await encryptMessageContent(keyring('v2'), 'after rotation', messageContext);

  assert.equal(getMessageEnvelopeKeyId(oldEnvelope), 'v1');
  assert.equal(getMessageEnvelopeKeyId(newEnvelope), 'v2');
  assert.equal(await decryptMessageContent(keyring('v2'), oldEnvelope, messageContext), 'before rotation');
});

test('incremental Worker Secrets add a new active key without replacing the legacy keyring', async () => {
  const legacyEnvelope = await encryptMessageContent(keyring('v1'), 'legacy keyring', messageContext);
  const incrementalEnv = {
    EDGECHAT_ENCRYPTION_KEYRING: keyring('v1'),
    EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID: 'auto-v1',
    EDGECHAT_ENCRYPTION_KEY_1: encodedKey(201)
  };
  const newEnvelope = await encryptMessageContent(incrementalEnv, 'incremental key', messageContext);

  assert.equal(getMessageEnvelopeKeyId(newEnvelope), 'auto-v1');
  assert.equal(await decryptMessageContent(incrementalEnv, legacyEnvelope, messageContext), 'legacy keyring');
  assert.equal(await decryptMessageContent(incrementalEnv, newEnvelope, messageContext), 'incremental key');
});

test('attachment encryption round-trips binary and binds the object key', async () => {
  const plaintext = Uint8Array.from([0, 1, 2, 3, 254, 255]);
  const encrypted = await encryptAttachment(keyring(), plaintext, '42/example.bin');

  assert.equal(isEncryptedAttachment(encrypted), true);
  assert.equal(getAttachmentEnvelopeKeyId(encrypted), 'v1');
  assert.notDeepEqual(encrypted, plaintext);

  const decrypted = await decryptAttachment(keyring(), encrypted, '42/example.bin');
  assert.equal(decrypted.encrypted, true);
  assert.equal(decrypted.keyId, 'v1');
  assert.deepEqual(decrypted.bytes, plaintext);
  await assert.rejects(
    decryptAttachment(keyring(), encrypted, '42/other.bin'),
    /authentication failed/
  );
});

test('attachment decryption keeps legacy bytes readable and rejects tampering', async () => {
  const plaintext = Uint8Array.from([10, 20, 30]);
  const legacy = await decryptAttachment(keyring(), plaintext, '42/legacy.bin');
  assert.equal(legacy.encrypted, false);
  assert.deepEqual(legacy.bytes, plaintext);

  const encrypted = await encryptAttachment(keyring(), plaintext, '42/example.bin');
  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(
    decryptAttachment(keyring(), encrypted, '42/example.bin'),
    /authentication failed/
  );
});

test('keyring validation rejects missing and incorrectly sized keys', () => {
  assert.throws(() => loadEncryptionKeyring(''), /is required/);
  assert.throws(
    () =>
      loadEncryptionKeyring(
        JSON.stringify({ activeKeyId: 'v1', keys: { v1: Buffer.from('short').toString('base64') } })
      ),
    /32 bytes/
  );
});
