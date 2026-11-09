#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# R2 首启自举：迁移（幂等）→ 探测未封箱则 mint 一次性 setup token → stdout 打印醒目深链接 → 起服务。
# 用户全程零密钥/零命令：JWT_PRIVATE_KEY 缺失时自动生成并落数据卷。
# TODO(#108): 密钥自举为过渡实现，R1（native workerd + node:sqlite）落地后本文件整块删除。
set -eu

PORT="${UNSELF_PORT:-8787}"
DATA_DIR="${UNSELF_DATA_DIR:-/app/data}"
PERSIST_DIR="$DATA_DIR/wrangler-state"   # wrangler --persist-to：D1 sqlite 等 miniflare 状态全落数据卷
CONFIG_DIR="/app"                        # 运行时生成的 wrangler.jsonc（容器可写层；main/assets 相对路径与镜像布局一致）
KEY_FILE="$DATA_DIR/jwt_private_key.pem"
export CI=true

mkdir -p "$PERSIST_DIR"

WR="$(command -v wrangler)"

# ---------------------------------------------------------------- wrangler 配置
# main/assets/d1 与装配器 .deploy/cloudflare/core.wrangler.jsonc 同构（run_worker_first、
# SPA 回退、CORE_DB/MODULES_DB）；本地模式下 database_id 仅作存储 key 用，占位即可。
cat > "$CONFIG_DIR/wrangler.jsonc" <<EOF
{
  "name": "unself-workbench",
  "main": "dist/worker.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/web",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "d1_databases": [
    { "binding": "CORE_DB", "database_name": "unself-core", "database_id": "docker-local", "migrations_dir": "migrations/core" },
    { "binding": "MODULES_DB", "database_name": "unself-modules", "database_id": "docker-local" }
  ]
}
EOF
cd "$CONFIG_DIR"

# ---------------------------------------------------------------- 控制面小工具
# d1 execute --json 按语句分段返回 [{"results":...},...]；解析统一走这里（依赖 node，镜像自带）。
d1_json() {
  "$WR" d1 execute CORE_DB --local --persist-to "$PERSIST_DIR" --json "$@" 2>/dev/null
}

# stdin: d1 --json → stdout: "<sealed|open> <token|->"（解析失败 exit≠0，由 set -e 兜住）
parse_status() {
  node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
  let rows;
  try { rows = JSON.parse(s); } catch { process.exit(3); }
  for (const r of rows) {
    const row = r && r.results && r.results[0];
    if (row && "sealed" in row) {
      process.stdout.write((Number(row.sealed) > 0 ? "sealed" : "open") + " " + (row.token || "-"));
      process.exit(0);
    }
  }
  process.exit(2);
});'
}

# 探测 SQL 与 core/control-plane SETUP_STATUS_SQL 同一形状（SQL 单点防漂移；此处为 shell 等价复制）
PROBE_SELECT="SELECT (SELECT COUNT(*) FROM instance_config WHERE key = 'setup_done' AND value = '1') AS sealed, (SELECT token FROM setup_tokens WHERE used_at IS NULL ORDER BY created_at LIMIT 1) AS token"

# ---------------------------------------------------------------- ① 迁移（幂等）
echo "[entrypoint] ① 应用 core 迁移（幂等，按 d1_migrations 记账）…"
"$WR" d1 migrations apply CORE_DB --local --persist-to "$PERSIST_DIR" >/dev/null

# ---------------------------------------------------------------- ② JWT 私钥自举
# TODO(#108)：R1 落地后密钥自举整块消失。优先用环境注入（用户自带密钥）；否则缺失即首启
# 生成一份存数据卷（0600），容器重建+卷保留则沿用；卷丢弃即换钥（存量会话失效，语义与
# CF secret 换钥一致）。绝不需要用户手工配。
if [ -n "${JWT_PRIVATE_KEY:-}" ]; then
  KEY_PEM="$JWT_PRIVATE_KEY"
  echo "[entrypoint] ② 使用环境注入的实例签名私钥（JWT_PRIVATE_KEY）"
elif [ -f "$KEY_FILE" ]; then
  KEY_PEM="$(cat "$KEY_FILE")"
  echo "[entrypoint] ② 实例签名私钥沿用数据卷既有文件"
else
  node -e '
const fs = require("node:fs");
const { privateKey } = require("node:crypto").generateKeyPairSync("ec", { namedCurve: "P-256" });
fs.writeFileSync(process.argv[1], privateKey.export({ type: "pkcs8", format: "pem" }) + "\n");
' "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  KEY_PEM="$(cat "$KEY_FILE")"
  echo "[entrypoint] ② 首启生成实例签名私钥 → $KEY_FILE（TODO(#108)：R1 后删除此自举）"
fi

# ---------------------------------------------------------------- ③ setup 探测 / mint
STATUS_OUT="$(d1_json --command "$PROBE_SELECT" | parse_status)"
SEALED="${STATUS_OUT%% *}"
TOKEN="${STATUS_OUT#* }"

if [ "$SEALED" = "sealed" ]; then
  echo "[entrypoint] ③ 实例已配置（setup 已封箱）：跳过 token 签发"
else
  if [ "$TOKEN" = "-" ]; then
    printf "INSERT INTO setup_tokens (token) VALUES (lower(hex(randomblob(24))));\n%s\n" "$PROBE_SELECT" > "$CONFIG_DIR/mint.sql"
    STATUS_OUT="$(d1_json --file "$CONFIG_DIR/mint.sql" | parse_status)"
    TOKEN="${STATUS_OUT#* }"
    echo "[entrypoint] ③ 已签发一次性 setup token（消费后自动作废）"
  else
    echo "[entrypoint] ③ 复用未消费的 setup token（幂等重跑收敛）"
  fi
fi

BASE_URL="${UNSELF_BASE_URL:-http://localhost:$PORT}"

# ---------------------------------------------------------------- ④ 深链接 + 起服务
# 一次性深链接是本容器的核心交付：用户点链接进 /setup 向导（复用现有向导，首任管理员即封箱）。
# UNSELF_BASE_URL 未设时按 localhost 打印——反代/远程访问场景请设置它，链接才会指向真实入口。
if [ "$SEALED" != "sealed" ] && [ "$TOKEN" != "-" ]; then
  cat <<EOF

==========================================================================
  ✅ Unself 核心已就绪
  一次性 setup 链接（点开配置管理员与实例设置；token 用后即焚，泄露请重建数据卷）：

      $BASE_URL/setup?token=$TOKEN

  （域名/端口取自 env：UNSELF_BASE_URL=${UNSELF_BASE_URL:-<未设置，按 localhost>} / UNSELF_PORT=$PORT）
==========================================================================

EOF
fi

echo "[entrypoint] ④ 启动 workbench（wrangler dev 进程模式，端口 $PORT）…"
exec "$WR" dev \
  --config "$CONFIG_DIR/wrangler.jsonc" \
  --port "$PORT" \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --var "JWT_PRIVATE_KEY:$KEY_PEM"
