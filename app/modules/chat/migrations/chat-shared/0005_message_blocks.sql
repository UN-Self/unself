-- SPDX-License-Identifier: AGPL-3.0-only
-- Ordered encrypted content lives beside chat_messages so the applied chat_messages table never needs a destructive rewrite.
CREATE TABLE IF NOT EXISTS chat_message_block_payloads (
  message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  content_blocks TEXT NOT NULL,
  attachment_keys TEXT
);
CREATE TABLE IF NOT EXISTS chat_message_attachments (
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  PRIMARY KEY (message_id, object_key)
);
CREATE INDEX IF NOT EXISTS chat_idx_message_attachments_key ON chat_message_attachments(object_key, message_id);
CREATE TRIGGER IF NOT EXISTS chat_validate_message_blocks_attachments BEFORE INSERT ON chat_message_block_payloads
WHEN NEW.attachment_keys IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.attachment_keys) AS item
    WHERE NOT EXISTS (SELECT 1 FROM chat_uploaded_files uf JOIN chat_messages m ON m.id = NEW.message_id WHERE uf.object_key = item.value AND uf.owner_user_id = m.sender_id)
      OR EXISTS (SELECT 1 FROM chat_pending_r2_delete WHERE object_key = item.value)
  );
END;
CREATE TRIGGER IF NOT EXISTS chat_index_message_blocks_attachments AFTER INSERT ON chat_message_block_payloads
WHEN NEW.attachment_keys IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO chat_message_attachments(message_id, object_key)
  SELECT NEW.message_id, value FROM json_each(NEW.attachment_keys);
END;
CREATE TRIGGER IF NOT EXISTS chat_queue_recalled_blocks AFTER UPDATE OF deleted_at ON chat_messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO chat_pending_r2_delete(object_key)
  SELECT object_key FROM chat_message_attachments WHERE message_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS chat_queue_deleted_blocks BEFORE DELETE ON chat_messages
BEGIN
  INSERT OR IGNORE INTO chat_pending_r2_delete(object_key)
  SELECT object_key FROM chat_message_attachments WHERE message_id = OLD.id;
  DELETE FROM chat_message_attachments WHERE message_id = OLD.id;
  DELETE FROM chat_message_block_payloads WHERE message_id = OLD.id;
END;
