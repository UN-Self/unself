// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local-only registry bootstrap for Chat.
 *
 * Chat needs D1/KV/DO and WebSocket, so it runs as its own wrangler/workerd container.
 * This script registers that direct local entry in Workbench without requiring the
 * browser admin session for a developer bootstrap.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'app', 'modules', 'chat', 'dist', 'manifest.json'), 'utf8'));
if (manifest.id !== 'chat' || typeof manifest.version !== 'string') {
  throw new Error('Chat manifest 无效：请先运行 pnpm build:local-chat');
}

const compose = ['compose', '--env-file', 'docker/.env', '-f', 'docker/compose.yml'];
const containerId = execFileSync('docker', [...compose, 'ps', '-q', 'workbench'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
if (!containerId) throw new Error('Workbench 容器未运行：请先运行 pnpm docker:core');

const manifestJson = JSON.stringify(manifest).replaceAll("'", "''");
const sql = `
INSERT INTO module_registry
  (id, enabled, version, manifest_json, mode, entry, storage_level, lifecycle, credential_hash)
VALUES
  ('chat', 1, '${manifest.version}', '${manifestJson}', 'docker',
   'http://localhost:8792/', 'core', 'active', NULL)
ON CONFLICT(id) DO UPDATE SET
  enabled = excluded.enabled,
  version = excluded.version,
  manifest_json = excluded.manifest_json,
  mode = excluded.mode,
  entry = excluded.entry,
  storage_level = excluded.storage_level,
  lifecycle = excluded.lifecycle,
  credential_hash = NULL;
`.trim();

execFileSync(
  'docker',
  [
    'exec',
    containerId,
    'npx',
    'wrangler',
    'd1',
    'execute',
    'CORE_DB',
    '--local',
    '--persist-to',
    '/app/data/wrangler-state',
    '--command',
    sql,
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

console.log('✓ Chat 已注册到本地 Workbench：http://localhost:8792/');
