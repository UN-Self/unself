#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * deploy/cloudflare 入口：仓库根执行 `node deploy/cloudflare/bin.ts`（或 tsx）。
 * 幂等九步见 README / PRODUCT_SPEC §5.5。
 */
import { main } from './src/main.ts';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
