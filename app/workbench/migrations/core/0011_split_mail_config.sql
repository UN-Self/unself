-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core 0011（issue #340）：instance_config 旧 `mail` 键拆为 `mail_stalwart`（开户）/ `mail_smtp`（发信）。
--
-- 口径（任务书已定决策 D1/D2/D5 + 拆键矩阵）：
-- - 旧 `mail` 行保留不删（回滚兼容），新代码零读取；
-- - enabled 恒为 JSON 布尔字面量（缺省关）：旧 enabled 取 json_extract('$.enabled')，
--   NULL/缺字段视为 1（保老数据缺省开语义），但仅当该侧字段齐时生效；
--   侧字段半齐（有部分字段）→ 落行但 enabled=false（半配置不开，字段只挑在场的）；
--   侧字段全空（无一命中）→ 不写该侧行；无 mail 行 / `{}` / JSON 损坏 → 两行都不写。
-- - 「字段齐」：stalwart = baseUrl+apiKey+domain 全为非空字符串；
--   smtp = host+port(>0 整数或纯数字字符串)+username+password+from 全为有效值。
-- - portalUrl 只在**非空字符串**时保留（JSON null / 空串不算字段，不因此凭空建段）。
-- - INSERT OR IGNORE 幂等，可重复应用（0001-0010 已应用的老库升级路径）。
-- JSON 布尔必须走文本字面量拼接：json_object/json_patch 会把 0/1 落成数字，
-- 而 JS 里 `1 === true` 为 false，读侧 `enabled === true` 判定会整体翻车。

-- 开户侧：mail_stalwart（只挑 baseUrl/apiKey/domain，portalUrl 若存在则保留）。
INSERT OR IGNORE INTO instance_config (key, value)
SELECT
  'mail_stalwart',
  '{"enabled":'
    || CASE
         WHEN typeof(json_extract(value, '$.baseUrl')) = 'text' AND json_extract(value, '$.baseUrl') <> ''
          AND typeof(json_extract(value, '$.apiKey')) = 'text' AND json_extract(value, '$.apiKey') <> ''
          AND typeof(json_extract(value, '$.domain')) = 'text' AND json_extract(value, '$.domain') <> ''
          AND COALESCE(json_extract(value, '$.enabled'), 1) <> 0
         THEN 'true'
         ELSE 'false'
       END
    || CASE WHEN typeof(json_extract(value, '$.baseUrl')) = 'text' AND json_extract(value, '$.baseUrl') <> ''
            THEN ',"baseUrl":' || json_quote(json_extract(value, '$.baseUrl')) ELSE '' END
    || CASE WHEN typeof(json_extract(value, '$.apiKey')) = 'text' AND json_extract(value, '$.apiKey') <> ''
            THEN ',"apiKey":' || json_quote(json_extract(value, '$.apiKey')) ELSE '' END
    || CASE WHEN typeof(json_extract(value, '$.domain')) = 'text' AND json_extract(value, '$.domain') <> ''
            THEN ',"domain":' || json_quote(json_extract(value, '$.domain')) ELSE '' END
    || CASE WHEN typeof(json_extract(value, '$.portalUrl')) = 'text' AND json_extract(value, '$.portalUrl') <> ''
            THEN ',"portalUrl":' || json_quote(json_extract(value, '$.portalUrl')) ELSE '' END
    || '}'
FROM instance_config
WHERE key = 'mail'
  AND json_valid(value)
  AND json_type(value) = 'object'
  AND (
        (typeof(json_extract(value, '$.baseUrl')) = 'text' AND json_extract(value, '$.baseUrl') <> '')
     OR (typeof(json_extract(value, '$.apiKey')) = 'text' AND json_extract(value, '$.apiKey') <> '')
     OR (typeof(json_extract(value, '$.domain')) = 'text' AND json_extract(value, '$.domain') <> '')
     OR (typeof(json_extract(value, '$.portalUrl')) = 'text' AND json_extract(value, '$.portalUrl') <> '')
  );

-- 发信侧：mail_smtp（只挑 host/port/username/password/from，port 为 >0 的整数）。
INSERT OR IGNORE INTO instance_config (key, value)
SELECT
  'mail_smtp',
  '{"enabled":'
    || CASE
         WHEN typeof(json_extract(value, '$.host')) = 'text' AND json_extract(value, '$.host') <> ''
          AND (
                (typeof(json_extract(value, '$.port')) = 'integer' AND json_extract(value, '$.port') > 0)
             OR (typeof(json_extract(value, '$.port')) = 'text'
                 AND json_extract(value, '$.port') <> ''
                 AND json_extract(value, '$.port') NOT GLOB '*[^0-9]*'
                 AND CAST(json_extract(value, '$.port') AS INTEGER) > 0)
          )
          AND typeof(json_extract(value, '$.username')) = 'text' AND json_extract(value, '$.username') <> ''
          AND typeof(json_extract(value, '$.password')) = 'text' AND json_extract(value, '$.password') <> ''
          AND typeof(json_extract(value, '$.from')) = 'text' AND json_extract(value, '$.from') <> ''
          AND COALESCE(json_extract(value, '$.enabled'), 1) <> 0
         THEN 'true'
         ELSE 'false'
       END
    || CASE WHEN typeof(json_extract(value, '$.host')) = 'text' AND json_extract(value, '$.host') <> ''
            THEN ',"host":' || json_quote(json_extract(value, '$.host')) ELSE '' END
    || CASE WHEN
             (typeof(json_extract(value, '$.port')) = 'integer' AND json_extract(value, '$.port') > 0)
          OR (typeof(json_extract(value, '$.port')) = 'text'
              AND json_extract(value, '$.port') <> ''
              AND json_extract(value, '$.port') NOT GLOB '*[^0-9]*'
              AND CAST(json_extract(value, '$.port') AS INTEGER) > 0)
            THEN ',"port":' || CAST(CAST(json_extract(value, '$.port') AS INTEGER) AS TEXT) ELSE '' END
    || CASE WHEN typeof(json_extract(value, '$.username')) = 'text' AND json_extract(value, '$.username') <> ''
            THEN ',"username":' || json_quote(json_extract(value, '$.username')) ELSE '' END
    || CASE WHEN typeof(json_extract(value, '$.password')) = 'text' AND json_extract(value, '$.password') <> ''
            THEN ',"password":' || json_quote(json_extract(value, '$.password')) ELSE '' END
    || CASE WHEN typeof(json_extract(value, '$.from')) = 'text' AND json_extract(value, '$.from') <> ''
            THEN ',"from":' || json_quote(json_extract(value, '$.from')) ELSE '' END
    || '}'
FROM instance_config
WHERE key = 'mail'
  AND json_valid(value)
  AND json_type(value) = 'object'
  AND (
        (typeof(json_extract(value, '$.host')) = 'text' AND json_extract(value, '$.host') <> '')
     OR (typeof(json_extract(value, '$.port')) = 'integer' AND json_extract(value, '$.port') > 0)
     OR (typeof(json_extract(value, '$.port')) = 'text'
         AND json_extract(value, '$.port') <> ''
         AND json_extract(value, '$.port') NOT GLOB '*[^0-9]*'
         AND CAST(json_extract(value, '$.port') AS INTEGER) > 0)
     OR (typeof(json_extract(value, '$.username')) = 'text' AND json_extract(value, '$.username') <> '')
     OR (typeof(json_extract(value, '$.password')) = 'text' AND json_extract(value, '$.password') <> '')
     OR (typeof(json_extract(value, '$.from')) = 'text' AND json_extract(value, '$.from') <> '')
  );

-- 复查（迁移三坑：先 COUNT 后复查——行数随旧数据形状变化，落库行数必须与拆键矩阵一致）。
SELECT
  (SELECT COUNT(*) FROM instance_config WHERE key = 'mail_stalwart') AS stalwart_rows,
  (SELECT COUNT(*) FROM instance_config WHERE key = 'mail_smtp') AS smtp_rows;
