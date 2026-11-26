#!/bin/zsh
# Fresh Meta-Team demo for a Mac with the DSH CLI and the plugin installed.
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
HERE="$(cd -- "$(dirname -- "$0")" && pwd -P)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
POOL="$HERE/../pool"

if ! command -v dsh >/dev/null 2>&1; then
  print -u2 '没有找到 dsh 命令。请先在这台 Mac 安装 DSH CLI，并确保终端能运行 dsh。'
  exit 1
fi
if [[ ! -f "$DSH_HOME_DIR/profiles/web/node_modules/dsh-meta-team/package.json" ]]; then
  print -u2 '请先在本机 DSH 的 web profile 安装 dsh-meta-team v0.1.1；安装方式见仓库 README。'
  exit 1
fi
if [[ ! -f "$POOL/pool.yaml" ]]; then
  print -u2 '找不到示例成员池。请完整解压 GitHub ZIP，不要只下载启动器。'
  exit 1
fi
POOL="$(cd -- "$POOL" && pwd -P)"
RUNS="$DSH_HOME_DIR/meta-team-demo-runs"
mkdir -p -- "$RUNS"
RUNS="$(cd -- "$RUNS" && pwd -P)"
RUN="$(mktemp -d "$RUNS/run.XXXXXX")"
mkdir -- "$RUN/workspace"

# Single-quoted YAML scalars allow spaces, backslashes, and apostrophes in paths.
quote_yaml() {
  local value="$1" quote="'"
  printf "'%s'" "${value//$quote/$quote$quote}"
}
cat > "$RUN/meta-team.patch.yml" <<YAML
- id: meta-team-research
  disabled: false
  config:
    poolDir: $(quote_yaml "$POOL")
    stateDir: $(quote_yaml "$RUN/state")
    workspace: $(quote_yaml "$RUN/workspace")
    mode: collaborative
    provider: $(quote_yaml "${METATEAM_PROVIDER:-deepseek-account}")
    model: $(quote_yaml "${METATEAM_MODEL:-deepseek-flash}")
    executionTimeoutMs: 1800000
    phaseTimeoutMs: 600000
    maxMessages: 200
YAML

cd -- "$RUN/workspace"
print -r -- "本次演示的状态目录：$RUN/state"
print '使用新打开的网页，先发 /meta status。两轮之间新建聊天，不要再次打开启动器。'
exec dsh --profile web --patch "$RUN/meta-team.patch.yml" --host 127.0.0.1 --port 0
