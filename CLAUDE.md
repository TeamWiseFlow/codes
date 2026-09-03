# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

Feishu-Codex Bridge: 将飞书机器人连接到 OpenAI 开源的 Codex CLI（`codex app-server`），通过飞书消息直接操控服务器上的 Codex 子进程。每个项目一个 `codex app-server` 子进程，走 JSON-RPC 2.0 over stdio（JSONL 分帧）。

基座选型背景见 `docs/base-migration-comparison.md`（Claude Code / dsh / codex / pi 横向对比，最终选定 codex：生产级成熟度 + 第三方模型无负优化 + 自带跨会话 memory）。

## Commands

```bash
node bridge/bridge.mjs              # 启动 bridge
node bridge/bridge.mjs --selftest   # 自测模式（验证配置，不连接飞书）

# systemd 服务管理（用户级服务）
systemctl --user restart codes-feishu-bridge.service   # 重启
systemctl --user status codes-feishu-bridge.service    # 查看状态
systemctl --user stop codes-feishu-bridge.service      # 停止
systemctl --user start codes-feishu-bridge.service     # 启动
```

## Architecture

```
bridge.mjs (单 Node.js 进程)
├── loadBridgeConfig() — 读取 ~/.codes/bridge.json（projects/providers/codexDefaults）
├── ensureCodexHome() — 从 bridge.json 生成 ~/.codes/codex-home/config.toml
│     ├── [model_providers.*] — providers 映射（base_url + env_key + wire_api=responses）
│     ├── [features] memories = true — codex 内置跨会话记忆管线
│     └── 默认 model / model_provider / approval_policy / sandbox_mode
├── CodexAppServer (每个项目一个) — 管理 codex app-server 子进程
│     ├── start(): spawn codex app-server → initialize 握手 → initialized
│     ├── _ensureThread(): thread/resume（有 threadId）或 thread/start；
│     │     per-project 的 model/modelProvider/sandbox/approvalPolicy/contextWindow
│     │     覆盖在此应用（contextWindow 走 thread 级 config.model_context_window）
│     ├── sendMessage(): turn/start 发送用户消息 → 等待 turn/completed
│     │     ├── item/agentMessage/delta — 流式增量（飞书打字机卡片）
│     │     ├── item/started/completed — 工具生命周期（进度提示）
│     │     ├── thread/tokenUsage/updated — token 统计（/cost /context）
│     │     └── 最终文本 = 最后一个 agentMessage item（工具前的过程叙述会被丢弃）
│     ├── interrupt(): turn/interrupt + 8s 看门狗兜底
│     ├── 服务端请求（审批/询问）: 全部自动应答，绝不挂起
│     │     （approvalPolicy=never 下正常不会发生）
│     └── stop(): SIGTERM → SIGKILL（5s 超时）；崩溃后下次消息自动重建连接并 resume
├── ProjectManager — 管理多个项目的进程生命周期
│     ├── init() — 按项目实例化 CodexAppServer，恢复会话，注册信号处理
│     ├── startProject/stopProject/resetProject — 按 alias 启停/重置
│     └── _saveSessions/_loadSessions — 持久化到 ~/.codes/bridge-sessions.json
└── FeishuBot (每个项目一个) — 管理飞书 WebSocket 连接
      ├── createLarkChannel (每个 bot app 一个，SDK 1.66+)
      ├── channel.on({ message, cardAction, ... }) 事件监听
      ├── channel.stream({ markdown }) 流式回复（打字机效果 + 自动 rollover）
      └── channel.send 非流式回复（slash 命令等）
```

### 沙箱与审批姿态

本机（及多数受限环境）无法创建 user namespace（AppArmor 限制），codex 的 bubblewrap 沙箱不可用。默认配置为 `sandbox: danger-full-access` + `approvalPolicy: never` —— 代理在受信服务器上自主执行，不弹审批。这与历史 Claude bridge 的 `--dangerously-skip-permissions` 姿态一致。若环境支持沙箱，可在 `bridge.json` 的 `codexDefaults` 或项目级 `codex` 改为 `workspace-write`。

### 跨会话记忆

codex 内置两阶段 memory 管线（会话结束后台提取结构化记忆 → 全局合并到 `$CODEX_HOME/memories/`，下次会话注入），由生成的 config.toml 中 `[features] memories = true` 启用。**无需外挂 memory MCP**。

## Key Files

| File | Purpose |
|------|---------|
| `bridge/bridge.mjs` | 核心代码：CodexAppServer, ProjectManager, FeishuBot, 消息路由 |
| `bridge/bridge.example.json` | 配置模板 |
| `bridge/setup-service.mjs` | systemd/launchd 服务生成器 |
| `bridge/package.json` | Node.js 依赖 |
| `bridge/.env.example` | 环境变量调优参考（含模型 API key 位置说明） |

## Config

- `~/.codes/bridge.json` — 项目配置（路径、飞书凭据、providers、codexDefaults、项目级 codex 覆盖：model/provider/sandbox/approvalPolicy/contextWindow）
- `~/.codes/bridge-sessions.json` — 会话持久化（自动管理；sessionId 即 codex thread id）
- `~/.codes/codex-home/` — bridge 托管的 CODEX_HOME：config.toml（生成）、会话 rollout、memories
- `bridge/.env` — 模型端点 API key（`providers.*.envKey` 对应变量）与可选调优变量

## Key Patterns

- **app-server 协议**: `codex app-server` 的 JSON-RPC 2.0 stdio 模式。协议基线版本 0.152.1（`EXPECTED_CODEX_VERSION`），codex stable 2-4 天一版，升级后先跑 `--selftest` + 冒烟验证
- **会话持久化**: thread id 即 session；codex rollout 落盘在 `~/.codes/codex-home/sessions/`，bridge 重启后 `thread/resume` 恢复；resume 失败（线程被删等）自动降级为新线程
- **飞书流式回复**: `channel.stream({ markdown: producer })` 使用飞书原生 streaming card（打字机效果），SDK 自动处理 throttling 和 rollover（超 30KB 自动续接新卡片）
- **过程卡只显示进度**: 最终结论一次性落卡（飞书流式卡编辑次数上限约 40 次的教训），进度编辑有 PROGRESS_EDIT_CAP，心跳 120s 一次
- **processAndReply()**: 统一的 Codex→飞书回复函数，优先走 streaming 路径，stream 启动失败时 fallback 到非流式 sendReplyToFeishu()；表格多的结论 / 超长轮次绕过流式卡，另发普通卡片
- **最终文本语义**: 一轮中最后一个 `agentMessage` item 的文本才是结论；工具调用之前的叙述文本在工具开始时丢弃（与历史 AtomCode `_finalText` 语义一致）
- **消息队列**: 单槽设计（pendingMessages Map），Codex 忙碌时新消息排队（保留最新一条），处理完自动 drainQueue；busy 状态在 sendMessage 入口**同步**置位，杜绝并发双 turn
- **打断机制**: `/interrupt` → `turn/interrupt`，8 秒看门狗兜底强制收尾
- **服务端请求必应答**: 审批（item/commandExecution/requestApproval 等）、询问（item/tool/requestUserInput）、elicitation 全部自动应答（accept / 空答案 / decline），未知请求回 JSON-RPC error —— 任何情况下不让 turn 挂起
- **多 bot 初始化**: 每个 feishu.appId 对应独立的 createLarkChannel 实例，一个 bridge 进程可服务多个飞书 bot
- **飞书命令**: `/start`, `/stop`, `/reset`, `/interrupt`, `/model`, `/cost`, `/context`, `/compact`, `/status`, `/backup`, `/scheduled`, `/unschedule`, `/help` — 未识别的斜杠命令作为普通消息转发给 Codex
- **延迟发送**: `/小时-分钟 "要延迟发送的消息"` 定时发给 Codex
- **immutable config**: 配置在启动时加载，运行时不修改原始对象
- **备份**: 每日自动打包 `~/.codes`（含 codex-home 的会话与记忆），排除 logs 与 bridge-sessions.json

## CI

- `ci.yml`: Node.js 22, `npm ci`, 语法检查, `--selftest`
- Commit messages 使用 conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:` 等)
