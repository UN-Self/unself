// SPDX-License-Identifier: GPL-3.0-only
import { decryptMessageContent } from '../encryption.js';
import { replaceMentionTokens } from './mentions.js';

export async function messagePreview(env, row) {
  if (!row.last_message_id) return null;
  const content = await decryptMessageContent(env, row.last_message_content, {
    channelId: row.id,
    senderId: row.last_message_sender_id ?? 0,
    senderContext: row.last_message_sender_kind === 'external'
      ? `${row.last_message_source}:${row.last_message_external_sender_id}` : '',
  });
  const text = content.trim();
  if (text) {
    // 预览里的 `@username` token 换成 `@displayName`（只换显示；先替换后截断，displayName 可能比 token 长）。
    // 名字映射由 listVisibleChannels 的 SQL 内联返回（last_message_mentions_json，同 messages.js mentions_json 口径），
    // 这里不二次查 users；mention 映射坏数据只降级为「不替换」，绝不能让频道列表整接口 500。
    let mentions = [];
    try {
      const parsed = JSON.parse(row.last_message_mentions_json || '[]');
      if (Array.isArray(parsed)) mentions = parsed;
    } catch {
      mentions = [];
    }
    return replaceMentionTokens(text, mentions).slice(0, 160);
  }
  if (row.last_message_attachment_kind === 'voice') return '[语音]';
  if (row.last_message_attachment_key) return `[附件] ${row.last_message_attachment_name || ''}`.trim();
  return '';
}
