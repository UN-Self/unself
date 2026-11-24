-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）0011（issue #340）：instance_config 旧 `mail` 键拆为
-- `mail_stalwart`（开户）/ `mail_smtp`（发信）。
--
-- 与 core/0011_split_mail_config.sql 同一逻辑迁移，语义逐条对齐（口径见那份文件的注释）：
-- - 旧 `mail` 行保留不删（回滚兼容），新代码零读取；
-- - enabled 恒为 JSON 布尔字面量（缺省关）：旧 enabled 缺字段视为开，显式 false/0 视为关，
--   但仅当该侧字段齐时生效；侧字段半齐 → 落行但 enabled=false；侧字段全空 → 不写该侧行；
--   无 mail 行 / `{}` / JSON 损坏 → 两行都不写；
-- - 「字段齐」：stalwart = baseUrl+apiKey+domain 全为非空字符串；
--   smtp = host+port(>0 整数或纯数字字符串)+username+password+from 全为有效值；
-- - portalUrl 只在非空字符串时保留（JSON null / 空串不算字段）。
--
-- 方言差异：SQLite 用 json_extract / typeof / json_quote / GLOB 在 SQL 里拼 JSON 文本；
-- PG 用 jsonb 解析 + jsonb_build_object，天然产出 JSON 布尔与数字，再 jsonb_strip_nulls
-- 去掉「不在场字段」。JSON 损坏的判定用 PL/pgSQL 的 EXCEPTION 捕获（等价于 json_valid
-- 为假时零行）。`ON CONFLICT DO NOTHING` 等价于 `INSERT OR IGNORE`，可重复应用。
-- 原文件末尾的复查 SELECT 只是迁移期诊断（无数据效果），这里不保留。

DO $$
DECLARE
  mail_value text;
  parsed jsonb;
  enabled_ok boolean;
  base_url_ok boolean;
  api_key_ok boolean;
  domain_ok boolean;
  portal_ok boolean;
  host_ok boolean;
  port_ok boolean;
  username_ok boolean;
  password_ok boolean;
  from_ok boolean;
  have_stalwart boolean;
  have_smtp boolean;
  stalwart_complete boolean;
  smtp_complete boolean;
  out_json jsonb;
BEGIN
  SELECT value INTO mail_value FROM instance_config WHERE key = 'mail';
  IF mail_value IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    parsed := mail_value::jsonb;
  EXCEPTION WHEN others THEN
    RETURN; -- JSON 损坏：两行都不写（不因脏数据中断升级）
  END;

  IF jsonb_typeof(parsed) <> 'object' THEN
    RETURN;
  END IF;

  -- enabled 缺省视为开；显式 false / 0 视为关（对应 COALESCE(json_extract(...,'$.enabled'),1) <> 0）
  enabled_ok := COALESCE(
    (parsed -> 'enabled') IS NULL
      OR (parsed -> 'enabled') NOT IN ('false'::jsonb, '0'::jsonb),
    true
  );

  -- 在场字段 = JSON 字符串且非空
  base_url_ok := COALESCE(jsonb_typeof(parsed -> 'baseUrl') = 'string' AND parsed ->> 'baseUrl' <> '', false);
  api_key_ok := COALESCE(jsonb_typeof(parsed -> 'apiKey') = 'string' AND parsed ->> 'apiKey' <> '', false);
  domain_ok := COALESCE(jsonb_typeof(parsed -> 'domain') = 'string' AND parsed ->> 'domain' <> '', false);
  portal_ok := COALESCE(jsonb_typeof(parsed -> 'portalUrl') = 'string' AND parsed ->> 'portalUrl' <> '', false);
  host_ok := COALESCE(jsonb_typeof(parsed -> 'host') = 'string' AND parsed ->> 'host' <> '', false);
  username_ok := COALESCE(jsonb_typeof(parsed -> 'username') = 'string' AND parsed ->> 'username' <> '', false);
  password_ok := COALESCE(jsonb_typeof(parsed -> 'password') = 'string' AND parsed ->> 'password' <> '', false);
  from_ok := COALESCE(jsonb_typeof(parsed -> 'from') = 'string' AND parsed ->> 'from' <> '', false);
  -- port：整数或纯数字字符串且 > 0（JSON 浮点/布尔/空串均不合格）。
  -- 用 CASE 而非 AND 链接：PostgreSQL 不保证 AND 右式短路，`'abc'::numeric` 会先炸。
  port_ok := COALESCE(
    CASE WHEN (parsed ->> 'port') ~ '^[0-9]+$' THEN (parsed ->> 'port')::numeric > 0 ELSE false END,
    false
  );

  have_stalwart := base_url_ok OR api_key_ok OR domain_ok OR portal_ok;
  have_smtp := host_ok OR port_ok OR username_ok OR password_ok OR from_ok;
  stalwart_complete := enabled_ok AND base_url_ok AND api_key_ok AND domain_ok;
  smtp_complete := enabled_ok AND host_ok AND port_ok AND username_ok AND password_ok AND from_ok;

  -- 开户侧：mail_stalwart（只挑 baseUrl/apiKey/domain，portalUrl 若存在则保留）
  IF have_stalwart THEN
    out_json := jsonb_strip_nulls(jsonb_build_object(
      'enabled', stalwart_complete,
      'baseUrl', CASE WHEN base_url_ok THEN parsed ->> 'baseUrl' END,
      'apiKey', CASE WHEN api_key_ok THEN parsed ->> 'apiKey' END,
      'domain', CASE WHEN domain_ok THEN parsed ->> 'domain' END,
      'portalUrl', CASE WHEN portal_ok THEN parsed ->> 'portalUrl' END
    ));
    INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', out_json::text)
    ON CONFLICT (key) DO NOTHING;
  END IF;

  -- 发信侧：mail_smtp（只挑 host/port/username/password/from，port 为 >0 整数）
  IF have_smtp THEN
    out_json := jsonb_strip_nulls(jsonb_build_object(
      'enabled', smtp_complete,
      'host', CASE WHEN host_ok THEN parsed ->> 'host' END,
      'port', CASE WHEN port_ok THEN (parsed ->> 'port')::int END,
      'username', CASE WHEN username_ok THEN parsed ->> 'username' END,
      'password', CASE WHEN password_ok THEN parsed ->> 'password' END,
      'from', CASE WHEN from_ok THEN parsed ->> 'from' END
    ));
    INSERT INTO instance_config (key, value) VALUES ('mail_smtp', out_json::text)
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN;
END $$;
