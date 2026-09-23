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
# - 向导 SPA（web/，Vue + @unself/ui）先经 vite build 产出 dist/web（2026-09-22 Vue 迁移）：
#   server.ts 运行时按 import.meta.url 定位 dist/web，故它必须与 unself.mjs 一起随包发布。
# - 安装器自身身份烙印（#287，方案 A：esbuild --define）：构建身份由 scripts/build-info.ts（tsx）
#   计算——commit 解析复用 @unself/contracts 的 resolveBuildCommit（GITHUB_SHA → git → 抛错，
#   与 workbench 构建同一套规则；shell 里自拼 git rev-parse 会绕开这套规则，禁止）。
#   define 注入的产物不可变；开发树不经本脚本跑源码时回退到读 package.json + 'dev' 占位
#   （见 src/lib/identity.ts 注释），不会 crash。
set -e
cd "$(dirname "$0")/.."
./node_modules/.bin/vite build
BUILD_DEFINE=$(./node_modules/.bin/tsx scripts/build-info.ts)
echo "安装器身份烙印：${BUILD_DEFINE}"
./node_modules/.bin/esbuild scripts/bundle-entry.ts \
  --bundle --platform=node --format=esm --target=node22 \
  "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --external:esbuild \
  "--define:__UNSELF_INSTALLER_BUILD__=${BUILD_DEFINE}" \
  --outfile=dist/unself.mjs
# 许可证随包（AGPL 交付要求）
for f in LICENSE NOTICE; do
  [ -f "../../$f" ] && cp "../../$f" "dist/$f"
done
