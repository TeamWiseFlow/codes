# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

Feishu-Claude Bridge: 将飞书机器人连接到 Claude Code CLI，通过飞书消息直接操控服务器上的 Claude Code 子进程。

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
├── loadBridgeConfig() — 读取 ~/.codes/bridge.json
├── ClaudeProcess (每个项目一个) — 管理 claude 子进程
│     ├── spawn: claude --output-format stream-json --input-format stream-json
│     ├── stdin: 发送用户消息 (JSONL)
│     ├── stdout: 读取事件流，type:"assistant" 增量推送流式文本，type:"result" 标记轮次结束
│     ├── onStream: 流式回调，将累积文本实时推送给 Feishu streaming card
│     └── respawn: 下次消息时以 --resume <session-id> 自动重启
├── AtomCodeDaemon (可选后端，每个项目一个) — 管理 atomcode-daemon 子进程
│     ├── start(): spawn atomcode-daemon --host 127.0.0.1 --port N, 轮询 /health, 通过 POST /live/provider 固定模型
│     ├── sendMessage(): POST /live/message + 监听 /live SSE 流（text/reasoning/tool_start/tokens/permission_request 等 wire event）
│     ├── interrupt(): POST /live/cancel
│     └── stop(): SIGTERM → SIGKILL（5s 超时）
├── ProjectManager — 管理多个项目的进程生命周期
│     ├── init() — 按项目 backend 字段实例化 ClaudeProcess 或 AtomCodeDaemon，恢复会话，注册信号处理
│     ├── startProject/stopProject — 按 alias 启停
│     └── _saveSessions/_loadSessions — 持久化到 ~/.codes/bridge-sessions.json
└── FeishuBot (每个项目一个) — 管理飞书 WebSocket 连接
      ├── createLarkChannel (每个 bot app 一个，SDK 1.66+)
      ├── channel.on({ message, cardAction, ... }) 事件监听
      ├── channel.stream({ markdown }) 流式回复（打字机效果 + 自动 rollover）
      └── channel.send 非流式回复（slash 命令等）
```

### 双后端共存（Claude + AtomCode）

bridge.json 里每个项目可选 `backend` 字段，决定该项目走 Claude Code CLI 还是 AtomCode daemon：

| `backend` | 后端类 | 适用场景 | 默认模型 |
|------------|--------|----------|----------|
| `"claude"`（默认） | `ClaudeProcess` | 付费 Anthropic API、需要 Claude 生态 | 由 `claude` CLI 决定 |
| `"atomcode"` | `AtomCodeDaemon` | 走 AtomGit 免费 GLM-5.2 CodingPlan | `AtomGit-GLM-5.2`（可改 `atomcode.model`） |

两后端在同一个 bridge 进程里可以混合使用（每个项目一个独立子进程），互不干扰。`AtomCodeDaemon` 与 `ClaudeProcess` 暴露相同的鸭子类型接口（`sendMessage / interrupt / stop / restart / info / progressText`），`ProjectManager` 不感知差异。

### AtomCode DLC 安装

AtomCode 作为"可选 DLC 包"叠加到现有 Feishu-Claude Bridge 部署上，不影响 Claude Code 后端：

```bash
# 一键安装 atomcode 二进制 + 拷贝 claude_enhance 强化件到 ~/.atomcode/
chmod +x install-atomcode-dlc.sh && ./install-atomcode-dlc.sh

# 或通过环境变量自定义路径
ENHANCE_SRC=./claude_enhance ATOMCODE_HOME=~/.atomcode ./install-atomcode-dlc.sh

# 强制覆盖已存在的强化件
FORCE_OVERWRITE=1 ./install-atomcode-dlc.sh
```

`install-atomcode-dlc.sh` 做的事：
1. 通过官方 `install.sh` 下载 `atomcode` + `atomcode-daemon` 二进制
2. 把 `claude_enhance/` 下的 skills / agents / commands / contexts / rules / hooks 拷贝到 `~/.atomcode/` 对应目录
3. 写入最小 `~/.atomcode/config.toml`（default_provider = atomgit-glm-5.2），不覆盖已存在配置

**不改 systemd 服务**，不动 `bridge.json`。用户在 `bridge.json` 里把某个项目的 `backend` 改成 `"atomcode"` 后重启 bridge 即可启用。卸载 DLC 只需删除 `~/.atomcode/` 下对应子目录。

## Key Files

| File | Purpose |
|------|---------|
| `bridge/bridge.mjs` | 核心代码：ClaudeProcess, ProjectManager, FeishuBot, 消息路由 |
| `bridge/bridge.example.json` | 配置模板 |
| `bridge/setup-service.mjs` | systemd/launchd 服务生成器 |
| `bridge/package.json` | Node.js 依赖 |
| `bridge/.env.example` | 环境变量调优参考 |

## Config

- `~/.codes/bridge.json` — 项目配置（路径、飞书 AppID、secret 路径）
- `~/.codes/bridge-sessions.json` — 会话持久化（自动管理）
- `bridge/.env` — 可选环境变量覆盖

## Key Patterns

- **stream-json 协议**: Claude CLI 的 `--output-format stream-json --input-format stream-json` 模式，stdin/stdout 通过 JSONL 通信
- **飞书流式回复**: `channel.stream({ markdown: producer })` 使用飞书原生 streaming card（打字机效果），SDK 自动处理 throttling 和 rollover（超 30KB 自动续接新卡片）
- **processAndReply()**: 统一的 Claude→飞书回复函数，优先走 streaming 路径，stream 启动失败时 fallback 到非流式 sendReplyToFeishu()
- **会话持久化**: ClaudeProcess 自动保存 session-id，进程重启后以 `--resume` 恢复
- **多 bot 初始化**: 每个 feishu.appId 对应独立的 createLarkChannel 实例，一个 bridge 进程可服务多个飞书 bot
- **飞书命令**: `/start`, `/stop`, `/reset`, `/interrupt`, `/cost`, `/context`, `/status`, `/help` — 以 `/` 开头的消息作为控制命令处理；未识别的斜杠命令透传给 Claude Code
- **消息队列**: 单槽设计（pendingMessages Map），Claude 忙碌时新消息排队（保留最新一条），处理完自动 drainQueue
- **打断机制**: `/interrupt` 发送 SIGINT，ClaudeProcess._interrupted 标记使 _onProcessExit 走 resolve 路径而非 reject
- **延迟发送**：`/小时-分钟 “要延迟发送的消息”` xx 小时 xxx 分钟后，内容发给 claude code
- **immutable config**: 配置在启动时加载，运行时不修改原始对象

## CI

- `ci.yml`: Node.js 22, `npm ci`, 语法检查, `--selftest`
- Commit messages 使用 conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:` 等)

## ECC 同步范围（专注代码开发，排除非开发类内容）

上游：`https://github.com/affaan-m/everything-claude-code`
本地：`claude_enhance/`（在 codes 仓库内）

### 追踪的 Agents（`claude_enhance/agents/`）

代码开发相���：architect, build-error-resolver, code-reviewer, database-reviewer, doc-updater,
docs-lookup, e2e-runner, gan-evaluator, gan-generator, gan-planner, go-build-resolver, go-reviewer,
harness-optimizer, loop-operator, opensource-forker, opensource-packager, opensource-sanitizer,
performance-optimizer, planner, pr-test-analyzer, python-reviewer, refactor-cleaner, rust-reviewer,
security-reviewer, silent-failure-hunter, tdd-guide, type-design-analyzer, typescript-reviewer

### 追踪的 Skills（`claude_enhance/skills/`）

| 类别 | Skills |
|------|--------|
| 架构/设计 | api-design, hexagonal-architecture, backend-patterns, frontend-patterns, mcp-server-patterns |
| 语言/测试 | golang-patterns, golang-testing, python-patterns, python-testing, cpp-coding-standards, cpp-testing, django-*, java-coding-standards, jpa-patterns, fastapi-patterns, rust-patterns, rust-testing |
| 数据库 | postgres-patterns, database-migrations, clickhouse-io, redis-patterns, mysql-patterns, prisma-patterns |
| DevOps | docker-patterns, deployment-patterns, e2e-testing |
| 安全 | security-review, security-bounty-hunter |
| Agent/Harness | continuous-agent-loop, gan-style-harness, autonomous-agent-harness, agent-introspection-debugging, eval-harness |
| 工具/流程 | tdd-workflow, verification-loop, search-first, strategic-compact, coding-standards, content-hash-cache-pattern, cost-aware-llm-pipeline, iterative-retrieval, regex-vs-llm-structured-text, prompt-optimizer, skill-stocktake, configure-ecc, error-handling |
| 前端/Web | frontend-a11y, nestjs-patterns, nextjs-turbopack, vite-patterns |
| 产品/协作 | product-capability, product-lens, project-flow-ops, terminal-ops, hookify-rules, safety-guard, skill-comply |

**不跟踪**：非开发类 skills（logistics, carrier, energy, investor, article-writing 等）、翻译文档（docs/ja-JP, docs/zh-TW）、swift/springboot/kotlin 生态（非主力语言）、continuous-learning/v1/v2（已移除）

### 追踪的 Rules（`claude_enhance/rules/`）

- `common/`：agents, code-review, coding-style, development-workflow, git-workflow, hooks, patterns, performance, security, testing
- `golang/`：coding-style, hooks, patterns, security, testing
- `python/`：coding-style, hooks, patterns, security, testing, fastapi
- `typescript/`：coding-style, hooks, patterns, security, testing
- `web/`：coding-style, design-quality, hooks, patterns, performance, security, testing

### Hooks 性能优化（2026-03-31）

- 移除：`post:edit:format`、`post:edit:typecheck`（每次 Edit 触发）
- 新增：`post:edit:accumulate`（仅记录文件路径）
- 新增：`stop:format-typecheck`（Stop 阶段批量处理，15x 延迟改善）
