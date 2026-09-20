#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# 打包单文件 CLI（#242 零克隆；#257 引擎进 bundle）：esbuild bundle 成 dist/unself.mjs（bin 入口）。
# - 平台 node、ESM、target node22；
# - banner 注入 createRequire：bundle 内第三方依赖的 CJS require 在 ESM 输出里可用；
# - 九步引擎（src/engine，与壳同包同树 #303）**不 external**（#257）：必须随 tarball 分发，
#   干净机器没有 node_modules 可解析；引擎随包后安装器运行期零依赖；
# - esbuild 保持 external 且惰性导入：只有「仓库形态 + 源码模块」的开发路径用得到它，
#   安装器产物形态（worker.js 已预打包）永不触发 → 干净机器不必装 esbuild；
# - blake3-wasm 是 createRequire 的运行时路径（wasm 用 fs 加载，进不了 bundle）→ 列为直接依赖，由 npm 随包装上。
# - 平台产物（core worker bundle / 壳 / 迁移 SQL）**不再随安装器内嵌**（#303 修订 #257）：
#   它们是 @unself/workbench 的预构建产物、随该包发布，引擎从 node_modules 读——installer 只出 CLI。
set -e
cd "$(dirname "$0")/.."
./node_modules/.bin/esbuild scripts/bundle-entry.ts \
  --bundle --platform=node --format=esm --target=node22 \
  "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --external:esbuild \
  --outfile=dist/unself.mjs
# 许可证随包（AGPL 交付要求）
for f in LICENSE NOTICE; do
  [ -f "../../$f" ] && cp "../../$f" "dist/$f"
done
