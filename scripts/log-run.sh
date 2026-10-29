#!/usr/bin/env bash
# =============================================================================
# scripts/log-run.sh — 把一条命令的完整输出（stdout + stderr）同时打到终端和
# logs/<日期>-<name>.log，作为可归档的构建 / 测试日志。
#
# 用法：
#   bash scripts/log-run.sh <name> [--raw] [--dir <dir>] -- <command...>
#
#   bash scripts/log-run.sh build -- pnpm build
#   bash scripts/log-run.sh test  -- pnpm test
#   bash scripts/log-run.sh smoke --raw -- bash scripts/e2e-mount.sh
#
# 产出：
#   logs/<YYYY-MM-DD>-<name>.log
#   同名已存在时依次追加 -2、-3 …（同一天多次跑不覆盖旧日志）。
#
# 日志格式（纯文本，可直接 grep / diff）：
#   # name:    build
#   # command: pnpm build
#   # cwd:     /abs/path/to/DSH-better-sidebar
#   # git:     a7a277e2 (main)
#   # started: 2026-10-29T11:52:21+0800
#   # log:     logs/2026-10-29-build.log
#   # ---
#   <命令的原始输出>
#   # exit:    0
#
# 约定：
#   - 默认剥离 ANSI 颜色转义，保证日志可 grep / 可 diff；--raw 保留原样。
#   - 退出码透传命令本身的退出码，包装层不改变 CI 语义。
#   - logs/ 已被 .gitignore 的 `logs` 规则忽略，日志不会进版本库。
#   - 纯开发侧工具，不进 npm 包（package.json files 白名单只含 install.*）。
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
用法: bash scripts/log-run.sh <name> [--raw] [--dir <dir>] -- <command...>

  <name>        日志名（作为文件名主体，/ 与空白会替换成 -）
  --raw         保留 ANSI 颜色转义（默认剥离）
  --dir <dir>   日志目录，默认 <repo>/logs
  -- <cmd...>   要执行的命令（必须用 -- 分隔）

示例:
  bash scripts/log-run.sh build -- pnpm build
  bash scripts/log-run.sh test  -- pnpm test
EOF
}

NAME=""
RAW=0
LOG_DIR="$ROOT/logs"

while [ $# -gt 0 ]; do
  case "$1" in
    --raw) RAW=1; shift ;;
    --dir)
      [ $# -ge 2 ] || { printf '错误: --dir 缺少参数\n' >&2; exit 2; }
      LOG_DIR="$2"; shift 2 ;;
    --dir=*) LOG_DIR="${1#--dir=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) printf '错误: 未知选项 %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -z "$NAME" ]; then
        NAME="$1"; shift
      else
        printf '错误: 多余参数 %s（命令请放在 -- 之后）\n' "$1" >&2
        exit 2
      fi ;;
  esac
done

[ -n "$NAME" ] || { printf '错误: 缺少日志名\n' >&2; usage >&2; exit 2; }
[ $# -gt 0 ] || { printf '错误: 缺少命令（-- 之后）\n' >&2; usage >&2; exit 2; }

# 文件名主体只允许安全字符：斜杠和空白替换成 -
NAME="${NAME//\//-}"
NAME="${NAME//[[:space:]]/-}"

mkdir -p "$LOG_DIR" || { printf '错误: 无法创建日志目录 %s\n' "$LOG_DIR" >&2; exit 2; }

stamp="$(date +%Y-%m-%d)"
LOG="$LOG_DIR/$stamp-$NAME.log"
suffix=2
while [ -e "$LOG" ]; do
  LOG="$LOG_DIR/$stamp-$NAME-$suffix.log"
  suffix=$((suffix + 1))
done

git_desc=""
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -n "$sha" ]; then
    git_desc="$sha"
    [ -n "$branch" ] && [ "$branch" != "HEAD" ] && git_desc="$sha ($branch)"
  fi
fi

rel_log="$LOG"
case "$LOG" in "$ROOT"/*) rel_log="${LOG#"$ROOT"/}" ;; esac

{
  printf '# name:    %s\n' "$NAME"
  printf '# command: %s\n' "$*"
  printf '# cwd:     %s\n' "$PWD"
  printf '# git:     %s\n' "${git_desc:-<not a git repo>}"
  printf '# started: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)"
  printf '# log:     %s\n' "$rel_log"
  printf '# ---\n'
} > "$LOG"

if [ "$RAW" -eq 1 ]; then
  "$@" 2>&1 | tee -a "$LOG"
else
  # $'...' 在 bash 层展开成真实 ESC 字节，BSD sed 与 GNU sed 都能匹配。
  "$@" 2>&1 | sed $'s/\033\\[[0-9;?]*[A-Za-z]//g' | tee -a "$LOG"
fi
status=${PIPESTATUS[0]}

printf '# exit:    %s\n' "$status" >> "$LOG"
printf '\n[log] %s (exit %s)\n' "$rel_log" "$status" >&2
exit "$status"
