// SPDX-License-Identifier: GPL-3.0-only
import { decryptMessageContent } from '../encryption.js';

export async function messagePreview(env, row) {
  if (!row.last_message_id) return null;
  const content = await decryptMessageContent(env, row.last_message_content, {
    channelId: row.id,
    senderId: row.last_message_sender_id ?? 0,
    senderContext: row.last_message_sender_kind === 'external'
      ? `${row.last_message_source}:${row.last_message_external_sender_id}` : '',
  });
  const text = content.trim();
  if (text) return text.slice(0, 160);
  if (row.last_message_attachment_kind === 'voice') return '[语音]';
  if (row.last_message_attachment_key) return `[附件] ${row.last_message_attachment_name || ''}`.trim();
  return '';
}
