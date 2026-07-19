#!/usr/bin/env bash
# ============================================================================
# AtomCode DLC 安装脚本
#
# 把 AtomCode 作为"可选 DLC 包"叠加到现有的 Feishu-Claude Bridge 部署上：
#   1. 通过官方 install.sh 下载并安装 atomcode + atomcode-daemon 二进制
#   2. 把仓库里的 claude_enhance/ 强化件拷贝到 ~/.atomcode/ 对应目录
#      （skills / agents / commands / contexts / rules / hooks）
#   3. 不动 systemd 服务、不动 bridge.json —— 用户在 bridge.json 里把某个
#      项目的 backend 改成 "atomcode" 即可启用
#
# 用法:
#   chmod +x install-atomcode-dlc.sh && ./install-atomcode-dlc.sh
#   或: curl -fsSL <url>/install-atomcode-dlc.sh | bash
#
# 前置要求: 已跑过 deploy.sh，bridge 已在跑
#           本脚本只追加 atomcode 能力，不影响现有 Claude Code 后端
# ============================================================================

set -euo pipefail

# ─── 颜色输出 ─────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
fatal() { err "$*"; exit 1; }

# ─── 配置变量 ─────────────────────────────────────────────────────
# claude_enhance 的源目录：默认在脚本同级的 ../claude_enhance
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENHANCE_SRC="${ENHANCE_SRC:-$SCRIPT_DIR/claude_enhance}"

# atomcode 的目标根目录（ATOMCODE_HOME）
ATOMCODE_HOME="${ATOMCODE_HOME:-$HOME/.atomcode}"

# atomcode 二进制安装路径（取自官方 install.sh 的 ATOMCODE_PREFIX 逻辑）
# 这里只设默认值，官方脚本会按平台/权限自己选 PREFIX
ATOMCODE_PREFIX="${ATOMCODE_PREFIX:-}"

# 是否强制覆盖已存在的强化件（默认 false：只新增、不覆盖）
FORCE_OVERWRITE="${FORCE_OVERWRITE:-0}"

echo ""
echo "============================================"
echo "  AtomCode DLC 安装"
echo "  给现有 Feishu-Claude Bridge 叠加 AtomCode 能力"
echo "============================================"
echo ""
info "ATOMCODE_HOME  = $ATOMCODE_HOME"
info "ENHANCE_SRC    = $ENHANCE_SRC"
info "FORCE_OVERWRITE= $FORCE_OVERWRITE"
echo ""

# ─── Phase 1: 下载并安装 atomcode 二进制 ─────────────────────────
info "Phase 1/3: 下载并安装 atomcode (atomcode + atomcode-daemon)..."

# 检查是否已安装
if command -v atomcode &>/dev/null && command -v atomcode-daemon &>/dev/null; then
  ok "atomcode 已安装: $(atomcode --version 2>/dev/null || echo 'unknown')"
  ok "atomcode-daemon 已安装: $(atomcode-daemon --version 2>/dev/null || echo 'unknown')"
else
  # 通过官方 install.sh 安装（curl | sh 模式）
  # 文档: https://atomgit.com/atomgit_atomcode/atomcode
  info "通过官方 install.sh 下载 atomcode..."
  if [ -n "$ATOMCODE_PREFIX" ]; then
    ATOMCODE_PREFIX="$ATOMCODE_PREFIX" sh -c '
      curl -fsSL https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh | sh
    '
  else
    curl -fsSL https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh | sh
  fi

  # 验证安装
  if ! command -v atomcode &>/dev/null && ! command -v atomcode-daemon &>/dev/null; then
    # 尝试 ~/.local/bin
    if [ -x "$HOME/.local/bin/atomcode" ] || [ -x "$HOME/.local/bin/atomcode-daemon" ]; then
      export PATH="$HOME/.local/bin:$PATH"
    elif [ -x "/usr/local/bin/atomcode" ] || [ -x "/usr/local/bin/atomcode-daemon" ]; then
      export PATH="/usr/local/bin:$PATH"
    fi
  fi

  if command -v atomcode &>/dev/null; then
    ok "atomcode 安装成功: $(atomcode --version 2>/dev/null || echo 'unknown')"
  else
    fatal "atomcode 安装失败。请手动跑: curl -fsSL https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/scripts/install.sh | sh"
  fi

  if command -v atomcode-daemon &>/dev/null; then
    ok "atomcode-daemon 安装成功"
  else
    warn "atomcode-daemon 未在 PATH 中找到"
    warn "atomcode 安装时通常会同时装 atomcode-daemon，请检查 ~/.local/bin 或 /usr/local/bin"
    warn "如果只有 atomcode 没有 atomcode-daemon，需要从源码编译:"
    warn "  git clone https://atomgit.com/atomgit_atomcode/atomcode.git"
    warn "  cd atomcode && cargo install --path crates/atomcode-daemon --locked"
  fi
fi

# ─── Phase 2: 拷贝 claude_enhance 强化件到 ~/.atomcode ──────────
info "Phase 2/3: 拷贝 claude_enhance 强化件到 $ATOMCODE_HOME ..."

if [ ! -d "$ENHANCE_SRC" ]; then
  fatal "claude_enhance 源目录不存在: $ENHANCE_SRC
请确认你在 codes 仓库根目录下运行此脚本，或通过 ENHANCE_SRC 环境变量指定路径。"
fi

mkdir -p "$ATOMCODE_HOME"

# 拷贝函数：把 src 下的内容拷到 dst，FORCE_OVERWRITE=0 时只新增不覆盖
copy_dir() {
  local src="$1"
  local dst="$2"
  local label="$3"

  if [ ! -d "$src" ]; then
    warn "$label: 源目录不存在，跳过 ($src)"
    return 0
  fi

  mkdir -p "$dst"

  if [ "$FORCE_OVERWRITE" = "1" ]; then
    # 强制覆盖：rsync -a --delete 会把 dst 同步成 src 的样子
    rsync -a --delete "$src/" "$dst/" 2>/dev/null || {
      # rsync 不在时用 cp -R
      rm -rf "$dst"
      cp -R "$src" "$dst"
    }
  else
    # 只新增不覆盖：用 cp -rn（no-clobber），macOS 和 Linux 都支持
    cp -Rn "$src/." "$dst/" 2>/dev/null || cp -R "$src/." "$dst/"
  fi

  local count
  count=$(find "$dst" -maxdepth 2 -type f 2>/dev/null | wc -l | tr -d ' ')
  ok "$label: 已拷贝到 $dst (~${count} 个文件)"
}

# 2.1 skills（每个 skill 是一个目录，含 SKILL.md）
copy_dir "$ENHANCE_SRC/skills" "$ATOMCODE_HOME/skills" "skills"

# 2.2 agents（每个 agent 是一个 .md 文件）
copy_dir "$ENHANCE_SRC/agents" "$ATOMCODE_HOME/agents" "agents"

# 2.3 commands（每个 slash command 是一个 .md 文件）
copy_dir "$ENHANCE_SRC/commands" "$ATOMCODE_HOME/commands" "commands"

# 2.4 contexts（每个 context 是一个 .md 文件）
copy_dir "$ENHANCE_SRC/contexts" "$ATOMCODE_HOME/contexts" "contexts"

# 2.5 rules（按语言子目录组织：common/typescript/python/golang/web）
if [ -d "$ENHANCE_SRC/rules" ]; then
  mkdir -p "$ATOMCODE_HOME/rules"
  for sub in common typescript python golang web; do
    if [ -d "$ENHANCE_SRC/rules/$sub" ]; then
      copy_dir "$ENHANCE_SRC/rules/$sub" "$ATOMCODE_HOME/rules/$sub" "rules/$sub"
    fi
  done
else
  warn "rules: 源目录不存在，跳过"
fi

# 2.6 hooks（TOML 格式 hooks.toml + JSON 格式 hooks.json）
# atomcode 加载 ~/.atomcode/hooks/hooks.toml（参见 hook/config_loader.rs）
if [ -d "$ENHANCE_SRC/hooks" ]; then
  mkdir -p "$ATOMCODE_HOME/hooks"
  # hooks.json 是 CC 格式，atomcode 也兼容（json_config.rs）
  if [ -f "$ENHANCE_SRC/hooks/hooks.json" ]; then
    if [ "$FORCE_OVERWRITE" = "1" ] || [ ! -f "$ATOMCODE_HOME/hooks/hooks.json" ]; then
      cp "$ENHANCE_SRC/hooks/hooks.json" "$ATOMCODE_HOME/hooks/hooks.json"
      ok "hooks.json: 已拷贝"
    else
      warn "hooks.json: 已存在，跳过（设 FORCE_OVERWRITE=1 强制覆盖）"
    fi
  fi
  # 拷贝 hooks 子目录里的脚本（如果有）
  for sub in scripts lib; do
    if [ -d "$ENHANCE_SRC/hooks/$sub" ]; then
      copy_dir "$ENHANCE_SRC/hooks/$sub" "$ATOMCODE_HOME/hooks/$sub" "hooks/$sub"
    fi
  done
else
  warn "hooks: 源目录不存在，跳过"
fi

# 2.7 mcp-configs（MCP 服务器配置）
if [ -d "$ENHANCE_SRC/mcp-configs" ]; then
  mkdir -p "$ATOMCODE_HOME"
  if [ -f "$ENHANCE_SRC/mcp-configs/mcp-servers.json" ]; then
    # atomcode 的 MCP 配置在 ~/.atomcode/mcp.json（不是 mcp-servers.json）
    # 这里做的是"复制并改名为 mcp.json"，不覆盖已有的 mcp.json
    if [ "$FORCE_OVERWRITE" = "1" ] || [ ! -f "$ATOMCODE_HOME/mcp.json" ]; then
      cp "$ENHANCE_SRC/mcp-configs/mcp-servers.json" "$ATOMCODE_HOME/mcp.json"
      ok "mcp.json: 已拷贝（从 mcp-servers.json 改名）"
    else
      warn "mcp.json: 已存在，跳过（设 FORCE_OVERWRITE=1 强制覆盖）"
    fi
  fi
fi

# 2.8 scripts（hooks 用的辅助脚本）
if [ -d "$ENHANCE_SRC/scripts" ]; then
  mkdir -p "$ATOMCODE_HOME/scripts"
  # 只拷贝脚本文件，不拷贝 ci/release.sh 这种
  for sub in hooks lib; do
    if [ -d "$ENHANCE_SRC/scripts/$sub" ]; then
      copy_dir "$ENHANCE_SRC/scripts/$sub" "$ATOMCODE_HOME/scripts/$sub" "scripts/$sub"
    fi
  done
  # 顶层 .js / .sh 文件
  for f in "$ENHANCE_SRC/scripts/"*.js "$ENHANCE_SRC/scripts/"*.sh; do
    [ -f "$f" ] || continue
    if [ "$FORCE_OVERWRITE" = "1" ] || [ ! -f "$ATOMCODE_HOME/scripts/$(basename "$f")" ]; then
      cp "$f" "$ATOMCODE_HOME/scripts/"
    fi
  done
fi

# ─── Phase 3: 写入最小 atomcode config.toml（如果不存在）─────────
info "Phase 3/3: 配置 atomcode ..."

CONFIG_TOML="$ATOMCODE_HOME/config.toml"

# 只有在 config.toml 不存在时才写入最小配置
# 如果用户已经手动配过 atomcode，我们不覆盖
if [ ! -f "$CONFIG_TOML" ]; then
  info "写入最小 config.toml (default_provider = atomgit-glm-5.2)..."
  cat > "$CONFIG_TOML" << 'CFGEOF'
# AtomCode 配置 — 由 install-atomcode-dlc.sh 生成
# 完整模板见: https://atomgit.com/atomgit_atomcode/atomcode/raw/main/docs/config.example.toml

default_provider = "atomgit-glm-5.2"

# AtomGit CodingPlan 免费 GLM-5.2（登录后通过 /login 自动配置 api_key）
[providers.atomgit-glm-5.2]
type     = "openai"
model    = "AtomGit-GLM-5.2"
base_url = "https://open.atomgit.com/api/v1"
# api_key 留空：登录后 /login 会自动写入 auth.json
# 或者手动填 CodingPlan 提供的 api_key
context_window = 64000

[datalog]
enabled = true
dir = "~/.atomcode/datalog"
CFGEOF
  ok "config.toml 已写入: $CONFIG_TOML"
  warn "请通过 atomcode /login 登录 AtomGit 账号以激活免费 GLM-5.2"
else
  ok "config.toml 已存在，跳过（不覆盖用户配置）: $CONFIG_TOML"
fi

# ─── 完成提示 ─────────────────────────────────────────────────────
echo ""
echo "============================================"
echo -e "  ${GREEN}AtomCode DLC 安装完成!${NC}"
echo "============================================"
echo ""
echo "  已安装内容:"
echo "    atomcode 二进制:    $(command -v atomcode 2>/dev/null || echo '未在 PATH')"
echo "    atomcode-daemon:    $(command -v atomcode-daemon 2>/dev/null || echo '未在 PATH')"
echo "    atomcode 配置:      $ATOMCODE_HOME/"
echo "    强化件来源:         $ENHANCE_SRC/"
echo ""
echo "  下一步：在 bridge.json 里给想用 atomcode 的项目加:"
echo ""
echo '    "backend": "atomcode",'
echo '    "atomcode": {'
echo '      "daemonBin": "atomcode-daemon",'
echo '      "approvalMode": "bypass",'
echo '      "port": 13456,'
echo '      "model": "AtomGit-GLM-5.2"'
echo '    }'
echo ""
echo "  然后重启 bridge:"
echo "    systemctl --user restart codes-feishu-bridge.service"
echo ""
echo "  首次使用 atomcode 请登录 AtomGit 以激活免费 GLM-5.2:"
echo "    atomcode   # 启动 TUI"
echo "    /login     # OAuth 登录"
echo ""
echo "  卸载 DLC（保留 atomcode 二进制）:"
echo "    rm -rf $ATOMCODE_HOME/skills $ATOMCODE_HOME/agents \\"
echo "           $ATOMCODE_HOME/commands $ATOMCODE_HOME/contexts \\"
echo "           $ATOMCODE_HOME/rules $ATOMCODE_HOME/hooks"
echo ""
