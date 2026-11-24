#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# 容器入口（#360 轨道 A）：自举全部在 Node 入口里——按 UNSELF_DB scheme 分发方言、跑迁移并按
# 文件名记账、私钥缺省生成落 UNSELF_DATA_DIR（0600）、首启未封箱则签发一次性 setup token 并
# 打印深链接。shell 只做一件事：把 PID 1 交给 node（信号直达，无中间 shell 残留）。
#
# 以非 root（node，uid 1000）运行：镜像内 /app/data 已归 node 所有，具名卷首次挂载继承该属主；
# 宿主目录 bind mount 时须宿主侧先 chown 1000:1000（见 docker/README.md）。
set -eu

exec node /app/dist/node/entry.node.cjs
