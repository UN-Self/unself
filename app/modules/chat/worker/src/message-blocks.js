// SPDX-License-Identifier: AGPL-3.0-only
import { getOwnedUploadedFileMetadata } from './data/uploaded-files.js';
import { publicFileUrl } from './utils.js';

export function blockText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 64) throw new Error('Invalid message blocks');
  let text = '';
  let files = 0;
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'attachment' && typeof block.attachment?.key === 'string') { files++; text += '\n'; }
    else throw new Error('Invalid message blocks');
  }
  if (files > 10 || text.length > 20000) throw new Error('Invalid message blocks');
  return text.trim();
}

export async function normalizeMessageBlocks(db, blocks, userId) {
  blockText(blocks);
  const result = [];
  const seen = new Set();
  for (const block of blocks) {
    if (block.type === 'text') { result.push({ type: 'text', text: block.text }); continue; }
    const key = block.attachment.key;
    if (seen.has(key)) throw new Error('Invalid message blocks');
    seen.add(key);
    const metadata = await getOwnedUploadedFileMetadata(db, key, userId);
    if (!metadata) throw new Error('Attachment is not available');
    result.push({ type: 'attachment', attachment: {
      key, name: metadata.filename, type: metadata.contentType, size: metadata.size, url: publicFileUrl(key),
    } });
  }
  return result;
}
