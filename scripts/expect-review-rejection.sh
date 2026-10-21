#!/usr/bin/env bash
# 待审受控插件的预期拒绝检查（插件仓 CI 用）。
#
# 受控能力的插件在源码审核通过前，validate / build / pack 必须被拒绝，且只能因为
# 「缺少适用的源码审核批准」被拒。命令意外通过（说明审批门失效）或出现任何其他错误都判失败。
# 用法：在插件目录内执行 bash ../../scripts/expect-review-rejection.sh validate build pack
set -uo pipefail

[ "$#" -gt 0 ] || { echo "用法: expect-review-rejection.sh <script>..." >&2; exit 2; }
output="$(mktemp)"
trap 'rm -f "$output"' EXIT

for script in "$@"; do
  bun run "$script" >"$output" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "FAIL $script: 待审插件意外通过，源码审核门没有生效" >&2
    exit 1
  fi
  # 审批拒绝是普通失败（退出码 1）；被信号终止、命令缺失等其他状态不能算作预期拒绝。
  if [ "$status" -ne 1 ]; then
    echo "FAIL $script: 异常退出（状态 $status），不是审批拒绝" >&2
    cat "$output" >&2
    exit 1
  fi
  if ! grep -q '^\[APP_CAPABILITY_NOT_GRANTED\] .* requires an applicable source review approval$' "$output"; then
    echo "FAIL $script: 失败原因不是缺少源码审核批准" >&2
    cat "$output" >&2
    exit 1
  fi
  unexpected="$(grep -v -E \
    -e '^\$ ' \
    -e '^\[APP_CAPABILITY_NOT_GRANTED\] .* requires an applicable source review approval$' \
    -e '^Plugin language validation failed$' \
    -e '^Manifest 校验未通过，构建中止$' \
    -e '^Prepared offline ' \
    -e '^error: script "[^"]+" exited with code 1$' \
    "$output")"
  if [ -n "$unexpected" ]; then
    echo "FAIL $script: 除审批拒绝外还有其他输出" >&2
    printf '%s\n' "$unexpected" >&2
    exit 1
  fi
  echo "PASS $script: 仅因缺少源码审核批准被拒"
done
