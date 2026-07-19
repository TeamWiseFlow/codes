# Codes — 打造你专属的 7*24 小时云端开发牛马（基于 claude code）

简单说，就是把 claude code 装在云服务器上，然后接入飞书。这样你就可以让它 7*24 为你开发了，因为 claude code 配合顶级的大模型开发能力已经足够强大（基本强于 985 研究生），所以就算你不懂开发也没问题，你就是老板，通过飞书下达指令，不管跟他讨论实现方案，还是让它给你出开发计划，抑或最终的开发实现、部署上线……你只需要用手机、飞书对话……懂不懂技术都没所谓。

<img src="docs/codes.png" alt="codes running demo" style="width: 100%;"/>

即便你是编程老手，其实用这个模式也很有价值，你可以从电脑前彻底解放，随时随地……搭配上豆包语音输入，打字都不需要了……

# 🌟 与 claude code 原版的 RC（remote control）功能相比

🚀【2026.3.7】新增：每日自动备份，bridge 在指定时间自动将配置和会话记忆打包备份到本地，支持 `/backup` 命令随时手动触发

🚀【2026.7.19】新增：**AtomCode DLC 后端**——bridge 现在支持双后端共存，每个项目可独立选择走 Claude Code CLI 还是 AtomCode daemon，互不干扰。

> ### 🎁 AtomCode DLC：每 7 天免费领 Pro，白嫽 GLM-5.2
>
> [AtomCode](https://github.com/instructkr/atomcode) 是基于 Claude Code 的开源二进制，走 AtomGit 的 GLM-5.2 CodingPlan。**最大亮点：每 7 天可以领一次 Pro 会员，免费使用 GLM-5.2 模型**——不花一分钱就能有一个 7×24 的云端编码牛马，对国内网络环境也友好。
>
> DLC 作为可选包叠加到现有部署上，**不动 systemd 服务、不动 bridge.json 的 Claude 项目**：
>
> ```bash
> # 一键安装 atomcode 二进制 + 强化件到 ~/.atomcode/
> chmod +x install-atomcode-dlc.sh && ./install-atomcode-dlc.sh
> ```
>
> 装完后在 `~/.codes/bridge.json` 里把某个项目的 `backend` 改成 `"atomcode"` 并重启 bridge 即可启用；卸载只需删 `~/.atomcode/` 下对应子目录。详见下方 [AtomCode DLC 安装](#atomcode-dlc-安装) 章节。

🚀【2026.3.5】新增：延迟消息（计划消息），`/小时-分钟 “要延迟发送的消息”` （xx 小时 xxx 分钟后，内容发给 claude code）

- 不需要 max/pro 订阅；
- 因为不需要订阅，因此可以用国内的第三方代理方案，也可以直接用 minimax 或者 kimi、glm、qwen 等 coding 套餐；
- 省不省钱的先不说，至少网络环境和账号这些麻烦不会存在了……

至于云端服务器，2C4G 足够了，腾讯云首单一年 79……当然因为本项目不需要公网 IP，所以你搞台二手电脑装个 ubuntu 扔家里或者办公室也是可以的……硬件几乎零成本。

**🌹 致敬：飞书连接桥方案来自：https://github.com/AlexAnys/feishu-openclaw**

**🎯 来自 https://github.com/affaan-m/everything-claude-code 的 claude code 强化插件**

本项目会直接安装来自 Anthropic 黑客马拉松获胜者的完整 Claude Code 配置集合。让你的 claude code 直接继承十年程序员开发功力！

生产级代理、技能、钩子、命令、规则和 MCP 配置，经过 10 多个月构建真实产品的密集日常使用而演化。

同时经过 modified，更加符合中国网络环境。

## 架构

```
飞书用户 ──WebSocket──▶ bridge.mjs ──stdin/stdout──▶ Claude Code CLI
                         │                              │
                    ProjectManager                 ClaudeProcess
                    (多项目管理)                  (stream-json 协议)
                         │
                    createLarkChannel × N
                    (每个项目一个飞书 bot)
```

- **bridge.mjs** — 单 Node.js 进程，同时服务多个飞书 bot + 多个 Claude Code 子进程
- **ClaudeProcess** — 通过 `stream-json` 协议与 Claude CLI 通信，支持会话持久化和自动重启
- **ProjectManager** — 管理多项目生命周期，每个项目独立的 Claude 实例和飞书 bot
- **createLarkChannel** — 飞书 SDK 1.66+ 高层 API，封装 WebSocket 连接、消息归一化、流式卡片、卡片交互回调

### 飞书 SDK 能力

| 能力 | 说明 |
|------|------|
| **消息归一化** | SDK 自动将 text/post/interactive/merge_forward 等消息类型归一化为统一格式 |
| **流式卡片** | CardKit 2.0 + `streaming_mode`，实时推送 Claude 输出到飞书卡片 |
| **卡片交互** | `cardAction` 回调，支持停止按钮等交互操作 |
| **Reaction v1** | 使用 `im.v1.messageReaction` API（v0 已弃用） |
| **WS 调优** | `pingTimeout: 3s`，`handshakeTimeoutMs: 8000`，应用层重连事件 |
| **Bot 身份** | `channel.botIdentity` 自动获取 bot 的 open_id |
| **优雅关闭** | `channel.disconnect()` 优雅断开 WebSocket |

## 前置要求

- **Node.js** 18+（推荐 22+）
- **@larksuiteoapi/node-sdk** 1.66.0（飞书 SDK，bridge 自带）
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **飞书自建应用** — 需要 App ID + App Secret（详见下方配置步骤）

## 快速开始

### 一键部署（Ubuntu 24.04）

```bash
curl -fsSL https://raw.githubusercontent.com/bigbrother666sh/codes/main/deploy.sh | bash
```

脚本会自动安装 Node.js、Claude Code CLI，引导配置飞书凭据，并创建 systemd 服务。

### 备份远端配置

```bash
git clone https://github.com/bigbrother666sh/codes.git
cd codes
./backup.sh <ssh目标> [本地备份目录]
```

示例：

```bash
./backup.sh incu
./backup.sh wukong@123.60.18.144 ./backups
```

会下载以下内容到本地时间戳目录：
- `~/.codes`（排除 `logs/` 和 `bridge-sessions.json`）
- `~/.claude.json`
- `~/.claude/settings.json`
- `~/.claude/projects/*/memory`

### 1. 克隆仓库

```bash
git clone https://github.com/bigbrother666sh/codes.git
cd codes/bridge
npm install
```

### 2. 创建配置文件

```bash
mkdir -p ~/.codes/secrets
cp bridge.example.json ~/.codes/bridge.json
```

编辑 `~/.codes/bridge.json`：

```json
{
  "projects": {
    "myapp": {
      "path": "/home/user/projects/myapp",
      "feishu": {
        "appId": "cli_xxx",
        "appSecretPath": "~/.codes/secrets/myapp_secret"
      }
    }
  },
  "claudePath": "claude",
  "debug": false
}
```

将飞书 App Secret 写入 secret 文件：

```bash
echo -n "your-app-secret" > ~/.codes/secrets/myapp_secret
chmod 600 ~/.codes/secrets/myapp_secret
```

### 3. 启动

```bash
node bridge.mjs
```

## 配置说明

### bridge.json 字段

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `projects` | 项目配置 map（alias → {path, feishu}） | 必填 |
| `projects.*.path` | 项目代码仓路径 | 必填 |
| `projects.*.feishu.appId` | 飞书 App ID | 必填 |
| `projects.*.feishu.appSecretPath` | Secret 文件路径 | 必填 |
| `projects.*.backend` | 后端类型：`"claude"`（默认）或 `"atomcode"` | `"claude"` |
| `projects.*.atomcode.daemonBin` | atomcode 二进制名/路径（仅 `backend:"atomcode"` 时生效） | `"atomcode"` |
| `projects.*.atomcode.port` | daemon 监听端口 | 自动分配 |
| `projects.*.atomcode.model` | 固定模型 | `"AtomGit-GLM-5.2"` |
| `thinkingThresholdMs` | thinking 状态提示阈值（ms） | 2500 |
| `claudePath` | Claude CLI 路径 | `"claude"` |
| `debug` | 调试模式 | `false` |
| `backup.time` | 每日自动备份时间（HH:MM） | `"04:16"` |
| `backup.dest` | 备份目标目录 | `"~/Backups"` |
| `backup` | 设为 `false` 可完全禁用自动备份 | — |

### 自动备份

bridge 内置每日定时备份，默认凌晨 04:16 将以下内容打包为 `backup_YYYYMMDD_HHmm.tar.gz`：

- `~/.codes`（排除 `logs/` 和 `bridge-sessions.json`）
- `~/.claude.json`
- `~/.claude/settings.json`
- `~/.claude/projects/*/memory`（跨项目记忆）

在 `bridge.json` 中配置：

```json
{
  "backup": {
    "time": "04:16",
    "dest": "~/Backups"
  }
}
```

设为 `false` 可完全禁用：

```json
{
  "backup": false
}
```

也可在飞书发 `/backup` 随时手动触发一次。

### .env 调优（可选）

参见 `bridge/.env.example`。可通过环境变量覆盖 bridge.json 中的值：

```bash
FEISHU_THINKING_THRESHOLD_MS=2500    # thinking 状态提示阈值
FEISHU_BRIDGE_DEBUG=1                # 调试模式
FEISHU_BRIDGE_MAX_LOCAL_FILE_MB=15   # 本地文件大小限制
FEISHU_BRIDGE_MAX_INBOUND_IMAGE_MB=12  # 入站图片大小限制
FEISHU_BRIDGE_MAX_INBOUND_FILE_MB=40   # 入站文件大小限制
```

### 飞书自建应用创建步骤

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，登录
2. 点击 **创建自建应用**
3. 填写应用名称（随意，比如 "My AI Assistant"）
4. 进入应用 → **添加应用能力** → 选择 **机器人**
5. 进入 **权限管理**，开通以下权限（推荐照抄，少踩坑）：
   - `cardkit:card:write` — 发送/更新交互卡片（**streaming 流式回复**必须，否则回退为普通文本）
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 以机器人身份发消息（避免 403）
   - `im:message.group_at_msg` — 接收群聊中 @ 机器人的消息
   - `im:message.p2p_msg` — 接收机器人单聊消息
   - `im:resource` — 上传/下载图片与文件（**收图/收视频**必须）
  
或者选择”批量导入/导出权限”复制如下

```json
{
  “scopes”: {
    “tenant”: [
      “cardkit:card:write”,
      “im:message”,
      “im:message.group_at_msg:readonly”,
      “im:message.p2p_msg:readonly”,
      “im:message:send_as_bot”,
      “im:resource”
    ],
    “user”: []
  }
}
```
6. 进入 **事件与回调** → **事件配置**：
   - 添加事件：`接收消息 im.message.receive_v1`
   - 请求方式选择：**使用长连接接收事件**（这是关键！）
   
   *坑点：此时要保证 codes 已在运行*
   
7. 发布应用（创建版本 → 申请上线）
8. 记下 **App ID** 和 **App Secret**（在"凭证与基础信息"页面）

## 飞书命令

在飞书中向 bot 发送以下命令：

| 命令 | 说明 |
|------|------|
| `/start [alias\|all]` | 启动项目的 Claude Code |
| `/stop [alias\|all]` | 停止项目的 Claude Code |
| `/reset [alias]` | 重置会话（清除历史，开始新对话） |
| `/interrupt [alias]` | 打断当前正在处理的消息 |
| `/cost [alias]` | 查看费用统计 |
| `/context [alias]` | 查看会话信息 |
| `/status` | 查看所有项目状态 |
| `/backup` | 立即触发一次备份 |
| `/help` | 显示帮助 |

其他 `/` 开头的消息会直接转发给 Claude Code（如 Claude 内置的 `/compact` 等）。
普通消息直接发送给对应项目的 Claude Code 处理。

### 消息队列与打断

当 Claude 正在处理上一条消息时，新发送的消息会自动排队（单槽设计，仅保留最新一条）：

```
用户发 A  →  Claude 开始处理
用户发 B  →  "⏳ 消息已排队" → B 进入等待
用户发 C  →  "⏳ 消息已排队（替换）" → C 替换 B
A 处理完  →  回复 A 结果  →  自动开始处理 C
```

如需打断当前处理，发送 `/interrupt`：

```
用户发 A  →  Claude 处理中
用户发 /interrupt  →  打断 A  →  自动处理排队消息（如有）
```

`/cost` 和 `/context` 不受队列限制——Claude 忙碌时返回 bridge 记录的数据，空闲时透传给 Claude Code 返回详细信息。

### 延迟消息发送

/xx-dd 消息：xx 小时 dd 分钟后发送一次（例：/2-15 服务器维护）【意味着从发送起2 小时 15 分钟后，把“服务器维护”这句话发给 claude code）
/scheduled [alias]：查看当前待发送定时任务
/unschedule <任务ID前缀> [alias]：撤回单个定时任务
/unschedule all [alias]：撤回该项目全部定时任务

## AtomCode DLC 安装

AtomCode 作为**可选 DLC 包**叠加到现有 Feishu-Claude Bridge 部署上，不影响 Claude Code 后端。装完之后，bridge 就能在同一个进程里同时服务 Claude 项目和 AtomCode 项目，每个项目按 `backend` 字段独立选路。

### 为什么用 AtomCode

- **每 7 天免费领 Pro 会员**，直接用 GLM-5.2 模型，零成本拥有 7×24 云端编码牛马；
- 国内网络环境友好，不依赖 Anthropic 官方 API 或海外代理；
- 与 Claude Code 后端共存，付费项目继续走 Claude，免费项目走 AtomCode，互不干扰。

### 一键安装

```bash
# 安装 atomcode 二进制 + 拷贝 claude_enhance 强化件到 ~/.atomcode/
chmod +x install-atomcode-dlc.sh && ./install-atomcode-dlc.sh

# 自定义强化件来源 / 安装目录
ENHANCE_SRC=./claude_enhance ATOMCODE_HOME=~/.atomcode ./install-atomcode-dlc.sh

# 强制覆盖已存在的强化件
FORCE_OVERWRITE=1 ./install-atomcode-dlc.sh
```

脚本做的事：

1. 通过官方 `install.sh` 下载 `atomcode` + `atomcode-daemon` 二进制到 `~/.local/bin/`；
2. 把 `claude_enhance/` 下的 skills / agents / commands / contexts / rules / hooks 拷贝到 `~/.atomcode/` 对应目录；
3. 写入最小 `~/.atomcode/config.toml`（`default_provider = atomgit-glm-5.2`），不覆盖已存在配置。

**不改 systemd 服务，不动 `bridge.json`。**

### 启用某个项目的 AtomCode 后端

编辑 `~/.codes/bridge.json`，把目标项目的 `backend` 改成 `"atomcode"`，并可选指定端口/模型：

```jsonc
{
  "xiaobei-dev": {
    "path": "/home/wukong/xiaobei-dev",
    "backend": "atomcode",          // 走 AtomCode daemon
    "atomcode": {
      "port": 13456,
      "model": "AtomGit-GLM-5.2"
    },
    "feishu": { /* ... */ }
  }
}
```

改完重启 bridge 生效：

```bash
systemctl --user restart codes-feishu-bridge.service
```

### 卸载 DLC

删除 `~/.atomcode/` 下对应子目录即可，并把 `bridge.json` 里该项目的 `backend` 改回 `"claude"`。

### 排错：`spawn atomcode ENOENT`

如果 bridge 起不来、journalctl 报 `spawn atomcode ENOENT`，是 systemd 服务 PATH 没包含 `~/.local/bin`（atomcode 二进制安装位置）。重新生成服务单元即可：

```bash
node bridge/setup-service.mjs   # 会把 ~/.local/bin 写进 PATH
systemctl --user daemon-reload && systemctl --user restart codes-feishu-bridge.service
```

## 服务部署

### 一键部署（Ubuntu 24.04）

```bash
curl -fsSL https://raw.githubusercontent.com/bigbrother666sh/codes/main/deploy.sh | bash
```

脚本会自动安装 Node.js、Claude Code CLI，引导配置飞书凭据，并创建 systemd 服务。
第一次安装会自动配置 systemd 服务，后面会开启自启。

### mcp的配置

本项目安装部署时，会自动应用 claude_enhance 里面的来自[everything-claude-code](https://github.com/affaan-m/everything-claude-code) —— The performance optimization system for AI agent harnesses. From an Anthropic hackathon winner. 的最佳实践配置，不仅能让你的 claude code 发挥最大能力，还能有效降低 token（通过细腻的分层任务自动切换不同的模型，以及跨 session 的持久记忆）

但是原版的 mcp 过于庞杂，很多也不适合国内环境，因此我精简为五个：github、memory、context7、magic、jina，这五个应该是编程都需要的

其中 github 需要你的 PAT，获取方式为：

```text
GITHUB_PERSONAL_ACCESS_TOKEN 是在 GitHub 里创建的个人访问令牌（PAT）。

打开 GitHub 的 Token 页面
https://github.com/settings/personal-access-tokens

选择创建方式

推荐：Fine-grained token（权限更细、更安全）
兼容旧工具：Tokens (classic)
按你的 MCP 用途勾权限

只读仓库：Contents: Read
需要提 Issue / PR：再加 Issues、Pull requests 的 Read and write
如果 classic token，常见最小是：repo（私有仓库）和 read:org（如需组织信息）
创建后复制 token 到 .claude.json 的 mcpserver-github 下
```

jina 需要获取 key，获取地址为：https://jina.ai/ 申请 api key，十分便宜

### 手动部署

```bash
# 1. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 3. 克隆并安装
git clone https://github.com/bigbrother666sh/codes.git ~/codes
cd ~/codes/bridge && npm install

# 4. 配置（参见上方「快速开始」）

# 5. 创建 systemd 服务
node setup-service.mjs
systemctl --user daemon-reload
systemctl --user enable codes-feishu-bridge
systemctl --user start codes-feishu-bridge
```

### 服务管理

```bash
# 查看状态
systemctl --user status codes-feishu-bridge

# 查看日志
journalctl --user -u codes-feishu-bridge -f

# 重启
systemctl --user restart codes-feishu-bridge
```

## 故障排查

| 症状 | 排查方法 |
|------|----------|
| bridge 启动后无反应 | 检查 `~/.codes/bridge.json` 格式，确认 secret 文件存在 |
| 飞书消息无响应 | 检查飞书应用权限，确认 WebSocket 模式已启用 |
| Claude 报错 | 确认 `claude --version` 可运行，检查 `~/.claude/settings.json` 配置 |
| 进程重启后会话丢失 | 正常行为——bridge 会自动以 `--resume` 恢复上次会话 |
| 多项目配置不生效 | 确认每个项目的 `feishu.appId` 不同，每个 bot 对应一个项目 |

## 自测

```bash
node bridge/bridge.mjs --selftest
```

验证配置加载和基本功能，不会连接飞书。

## License

MIT
