// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/message-encryption.test.js（GPL-3.0-only，裁剪版）
import assert from 'node:assert/strict';
import test from 'node:test';
import { insertMessage } from './data/messages.js';
import { isEncryptedMessageContent } from './encryption.js';

const testKeyring = JSON.stringify({
  activeKeyId: 'v1',
  keys: {
    v1: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64')
  }
});

test('insertMessage stores ciphertext and returns plaintext to the caller', async () => {
  let storedContent = null;
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes('INSERT INTO messages')) {
            storedContent = values[2];
            return {
              async run() {
                return { meta: { last_row_id: 99 } };
              }
            };
          }

          return {
            async all() {
              return {
                results: [
                  {
                    id: 99,
                    channel_id: 7,
                    content: storedContent,
                    attachment_key: null,
                    attachment_name: null,
                    attachment_type: null,
                    attachment_size: null,
                    created_at: '2026-08-10 12:00:00',
                    sender_id: 42,
                    sender_username: 'tester',
                    sender_display_name: 'Tester',
                    sender_avatar_key: null
                  }
                ]
              };
            }
          };
        }
      };
    }
  };

  const saved = await insertMessage(
    { DB: fakeDb, EDGECHAT_ENCRYPTION_KEYRING: testKeyring },
    { channelId: 7, senderId: 42, content: 'database plaintext', attachment: null }
  );

  assert.equal(isEncryptedMessageContent(storedContent), true);
  assert.equal(storedContent.includes('database plaintext'), false);
  assert.equal(saved.content, 'database plaintext');
});
