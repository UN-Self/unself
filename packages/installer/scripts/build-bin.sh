#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# 打包单文件 CLI（#242 零克隆）：esbuild bundle 成 dist/unself.mjs（bin 入口，npm bin 直接指向它）。
# - 平台 node、ESM、target node22；
# - banner 注入 createRequire：bundle 内第三方依赖的 CJS require 在 ESM 输出里可用；
# - @unself/deploy-cloudflare 保持 external：发布后从 registry 装独立版本，
#   workspace 开发时则由链接的 workspace 包提供（九步引擎不进 bundle）。
set -e
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/esbuild bin.ts \
  --bundle --platform=node --format=esm --target=node22 \
  "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --external:@unself/deploy-cloudflare \
  --outfile=dist/unself.mjs
