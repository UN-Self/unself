-- 0009 转发附件归属放宽（#347）：转发副本（source = 'forward'）的附件仍属原作者，
-- 触发器不得要求 owner = 副本 sender。涉及两个触发器（0001/0005 建，分别拦 messages
-- 与 message_block_payloads 的写入）：
--   1) prevent_pending_message_attachment_insert —— messages 插入时校验附件归属；
--   2) validate_message_blocks_attachments —— message_block_payloads 插入时校验附件归属。
-- owner 兜底只对转发行（source = 'forward'）豁免，普通发送仍由 DB 强制 owner = sender；
-- pending_r2_delete 检查同样只豁免转发行——被转发引用的 key 有存活 message_attachments
-- 引用，GC 删除前会做引用检查（gc.js findReferencedKeys），不会真的删掉仍被引用的对象。
-- 逐文件整份执行、按文件名记账，勿改已应用迁移。

DROP TRIGGER IF EXISTS prevent_pending_message_attachment_insert;
CREATE TRIGGER prevent_pending_message_attachment_insert
BEFORE INSERT ON messages
WHEN NEW.attachment_key IS NOT NULL
  AND (
    (
      NEW.sender_kind = 'local'
      AND NOT EXISTS (
        SELECT 1
        FROM uploaded_files
        WHERE object_key = NEW.attachment_key
          AND (NEW.source = 'forward' OR owner_user_id = NEW.sender_id)
          AND (
            NEW.source = 'forward'
            OR NOT EXISTS (
              SELECT 1 FROM pending_r2_delete
              WHERE pending_r2_delete.object_key = uploaded_files.object_key
            )
          )
      )
    )
    OR (
      NEW.sender_kind = 'external'
      AND EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE object_key = NEW.attachment_key
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

DROP TRIGGER IF EXISTS validate_message_blocks_attachments;
CREATE TRIGGER validate_message_blocks_attachments BEFORE INSERT ON message_block_payloads
WHEN NEW.attachment_keys IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.attachment_keys) AS item
    JOIN messages m ON m.id = NEW.message_id
    WHERE NOT EXISTS (SELECT 1 FROM uploaded_files uf WHERE uf.object_key = item.value)
      OR (
        m.source <> 'forward'
        AND (
          NOT EXISTS (
            SELECT 1 FROM uploaded_files uf2
            WHERE uf2.object_key = item.value AND uf2.owner_user_id = m.sender_id
          )
          OR EXISTS (SELECT 1 FROM pending_r2_delete WHERE object_key = item.value)
        )
      )
  );
END;
