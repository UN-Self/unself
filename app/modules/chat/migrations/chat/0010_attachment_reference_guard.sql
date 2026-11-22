-- 0010 附件清理引用守卫（#347）：撤回/硬删入待删清单前，排除仍被其他存活消息引用的 key。
-- 转发副本与源消息共享同一 R2 key（附件不复制，副本各自在 message_attachments 登记引用）；
-- 原触发器对任意一条撤回无条件入清单，而 canAccessFile 对清单内 key 一律拒绝——
-- 撤回后到 GC 引用检查跑完前，目标房间的副本附件全员 403（裂一阵再自己好）。
-- 守卫口径与 gc.js findReferencedKeys 一致：messages.attachment_key ∪ message_attachments。
-- 纯附件消息（无 blocks，只有 messages.attachment_key）本来就不在 message_attachments，
-- 本触发器不涉及；其清理走 GC 保留期/销号路径，行为不变。
-- 逐文件整份执行、按文件名记账，勿改已应用迁移。

DROP TRIGGER IF EXISTS queue_recalled_blocks;
CREATE TRIGGER queue_recalled_blocks AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO pending_r2_delete(object_key)
  SELECT ma.object_key FROM message_attachments ma
  WHERE ma.message_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM messages m2
      WHERE m2.id <> NEW.id AND m2.deleted_at IS NULL
        AND (m2.attachment_key = ma.object_key
          OR m2.id IN (SELECT message_id FROM message_attachments WHERE object_key = ma.object_key))
    );
END;

DROP TRIGGER IF EXISTS queue_deleted_blocks;
CREATE TRIGGER queue_deleted_blocks BEFORE DELETE ON messages
BEGIN
  INSERT OR IGNORE INTO pending_r2_delete(object_key)
  SELECT ma.object_key FROM message_attachments ma
  WHERE ma.message_id = OLD.id
    AND NOT EXISTS (
      SELECT 1 FROM messages m2
      WHERE m2.id <> OLD.id AND m2.deleted_at IS NULL
        AND (m2.attachment_key = ma.object_key
          OR m2.id IN (SELECT message_id FROM message_attachments WHERE object_key = ma.object_key))
    );
  DELETE FROM message_attachments WHERE message_id = OLD.id;
  DELETE FROM message_block_payloads WHERE message_id = OLD.id;
END;
