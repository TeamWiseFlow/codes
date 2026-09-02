# Agent 基座替换调研：Claude Code vs dsh vs codex vs pi

> 调研日期：2026-08-31 ~ 2026-09-01
> 分支：`feat/dsh-analysis`
> 参考仓库（本地克隆，已 gitignore）：`./deepseek-harness/`、`./codex/`、`./pi/`、`./claude-code/`

## 背景

飞书 bridge 当前基座是 Claude Code CLI（`claude --output-format stream-json --input-format stream-json` 子进程），另有 AtomCode daemon 作为 GLM 后端。本调研评估把基座替换为以下三个开源 agent harness 的可行性：

| 项目 | 仓库 | 语言 | License |
|---|---|---|---|
| dsh | deepseek-ai/deepseek-harness | TypeScript (Cordis 插件架构) | MIT |
| codex | openai/codex | Rust (codex-rs) | Apache-2.0 |
| pi | earendil-works/pi | TypeScript (monorepo) | MIT |

**bridge 对基座的硬需求**：

1. 程序化接口：发消息 + 流式增量文本（飞书 streaming card 打字机效果）
2. 多轮会话 + 跨进程恢复（`--resume` 等价物）
3. 打断（`/interrupt` 等价物）
4. 审批/权限可程序应答（或转发飞书卡片）
5. 模型接入：Anthropic + GLM（AtomGit/智谱 CodingPlan）双通道
6. 核心功能：CLAUDE.md 注入、compaction、skills（兼容现有 `claude_enhance/`）、跨会话 memory

---

## 一、自带功能对比

| 能力 | Claude Code | dsh | codex | pi |
|---|---|---|---|---|
| 会话持久化 + resume | `--resume` | ✅ 事件溯源（JSONL/SQLite 双后端），fork/冷读/崩溃恢复 | ✅ rollout JSONL + SQLite 索引，`thread/resume` | ✅ JSONL 树形（原生分支），`--session-id` 不存在则创建 |
| 跨会话 memory | ✅ auto memory 目录 | ❌ 无内置，MCP 外挂 | ✅ **全自动两阶段管线**（rollout → 结构化入库 → `~/.codex/memories/` 全局合并，读取时注入并带引用） | ❌ 核心无；pi-chat 扩展层有 |
| Compaction | auto-compact | ✅ 压力触发 + overflow 恢复重试 + `/compact` | ✅ 手动 + 自动（token 阈值可配） | ✅ 自动（阈值触发）+ `/compact` + 分支摘要 |
| 项目指令 | CLAUDE.md | ✅ AGENTS.md/CLAUDE.md 全链 + 用户全局 | ✅ AGENTS.md 逐级聚合 + override + 用户级 | ✅ 原生含 CLAUDE.md 候选序列 |
| Skills | SKILL.md | ✅ 格式兼容（默认不扫 `.claude/skills`，需 `customSkillDirs`） | ✅ 同格式（`~/.codex/skills`） | ✅ agentskills.io 标准，settings 直配 `~/.claude/skills` |
| Hooks | hooks.json | ✅ 原生事件点 + CC 兼容桥 `dsh-hooks-claude-code`（opt-in） | ✅ 12 事件（含 PreCompact/SubagentInterrupt 等） | ✅ extension 事件拦截（`tool_call` 可 block） |
| MCP | ✅ | ✅ client（仅 tools，无 resources/prompts） | ✅ client（**含 resources**）+ 自身可当 MCP server | ❌ 有意不内置，靠扩展 |
| 从 Claude 迁移 | — | skills/hooks 有兼容路径 | ✅ `external-agent-migration` 可导入 CC 的 config/MCP/hooks/memory/sessions | skills/CLAUDE.md 直接兼容 |
| 权限/沙箱 | ✅ | ✅ sandbox（bwrap/Landlock）+ approval，fail-closed；无 allow-always | ✅ Landlock/seccomp + execpolicy + granular approval（**最成熟**） | ❌ 无内置，靠容器（Gondolin/Docker/OpenShell）或扩展软门 |
| 长任务续跑 | 无 | ✅ goal 机制（round cap 256，默认启用） | — | — |

## 二、自带工具对比（model 可调用的 tool 集）

| 工具 | dsh | codex | pi |
|---|---|---|---|
| 文件读写/编辑 | read/write/edit（新鲜度守卫）+ str-replace-editor | apply_patch（统一 patch 格式） | read/write/edit |
| 搜索 | glob/grep（ripgrep） | ⚠️ 无独立 grep/glob（靠 shell） | grep/find/ls |
| Shell | bash（含后台/持久变体） | exec_command + write_stdin（持久进程） | bash + `!` 命令 |
| Web | web_search/web_fetch（后端可插） | ⚠️ 仅 hosted Responses 原生 web_search（自定义 provider 默认无） | ⚠️ 无内置 |
| Todo/Plan | todo_write + plan mode（人工审阅退出） | update_plan | ❌（官方明示不做，靠扩展） |
| 子代理 | in-process spawn/fork + 可外挂 ACP/CC/Codex 子代理 | 多 agent 协作工具组（V1/V2） | ❌（靠扩展，有官方示例） |
| 其他 | lsp、terminal、jobs、goal、session-query、ask-user、workflow、agent-team | view_image、request_user_input、send_user_message_async、get_context_remaining/new_context、tool_search、request_permissions、image_gen | 极简内核哲学（"intentionally does not include built-in MCP, sub-agents, plan mode, to-dos"） |

**丰富度：dsh > codex > pi**。dsh 工具面最接近 Claude Code；pi 是刻意的最小内核 + 扩展生态。

## 三、程序化接口对比

| 维度 | dsh | codex | pi |
|---|---|---|---|
| 最佳路线 | `--profile acp`（标准 ACP，stdio JSON-RPC） | `app-server`（JSON-RPC stdio，exec/IDE 扩展/Python SDK 的官方基座） | **SDK 同进程嵌入**（`createAgentSession()`） |
| 增量流式 | ✅ ACP session/update | ✅ `item/agentMessage/delta`（⚠️ `exec --json` 无 delta，exec 路线否决） | ✅ `message_update` 纯 delta（最干净） |
| 打断 | ✅ session/cancel | ✅ turn/interrupt | ✅ `abort()` |
| 跨进程 resume | ✅ session/resume + list | ✅ thread/resume | ✅ SessionManager.open() |
| 审批程序应答 | ✅ request_permission（客户端可自动答） | ✅ requestApproval 请求/应答（结构化程度最高） | ⚠️ extension 软门 |
| 排队/转向 | 单 prompt in-flight | thread/queue + turn/steer | **steer/followUp**（busy 时显式选转向或排队，语义最强） |
| ACP | ✅ 原生 | 官方适配器 `@agentclientprotocol/codex-acp`（多一跳） | ❌ |
| 排除的路线 | headless（一次性）；`dsh web`（浏览器信任模型） | `exec --json`（无流式增量）；ACP 适配器（多一跳双 experimental） | 子进程 RPC 模式（可行但放弃了嵌入优势） |

pi SDK 核心 API（与 bridge `ClaudeProcess` 语义一一对应）：

```typescript
interface AgentSession {
  prompt(text, options?): Promise<void>;   // ↔ sendMessage（busy 时需 streamingBehavior）
  steer(text): Promise<void>;              // 工具调用间隙注入转向
  followUp(text): Promise<void>;           // 排队等空闲（↔ 单槽消息队列，更强）
  abort(): Promise<void>;                  // ↔ /interrupt
  compact(instructions?): Promise<...>;    // ↔ /context 压缩
  subscribe(listener): () => void;         // ↔ stdout 事件流（message_update = assistant delta）
  sessionId: string; sessionFile?: string; // ↔ --resume 持久化
}
```

## 四、模型接入对比

| | dsh | codex | pi |
|---|---|---|---|
| LLM 层 | pi-ai（目录 + 自定义） | 自研（**只剩 Responses API**，`wire_api = "chat"` 已移除） | pi-ai 本体 |
| Anthropic | ✅ anthropic-messages 协议 | ⚠️ 需端点提供 OpenAI 兼容 `/v1/responses` | ✅ 内置 provider |
| GLM CodingPlan/AtomGit | ✅ 自定义 `openai-completions` 路由 | ⚠️ 同上，需验证端点 | ✅ **zai-coding-cn 内置**（open.bigmodel.cn）+ models.json 自定义 |
| provider 总数 | pi-ai 目录 + 任意自定义 | 4 个内置（全 Responses） | **~50 个**（DeepSeek/Kimi/MiniMax/Qwen/智谱/蚂蚁/小米等，中国厂商覆盖最全） |
| 国产网关 compat 开关 | ✅ 逐字段声明式 | ✅（http_headers/query_params） | ✅ compat 字段（supportsDeveloperRole 等） |
| 配置落点 | `~/.dsh/settings.yaml` + `.credentials.yaml` | `~/.codex/config.toml` | `~/.pi/agent/models.json`（热加载，`$ENV` 插值不落盘） |

**关于 codex 的修正结论**：最初判断 codex"出局"过于绝对。`wire_api = "chat"` 确已移除，但**只要我们常用的模型服务商都提供 `/v1/responses` 端点，codex 的模型接入就不是障碍**。我们常用服务商（Anthropic 兼容层、GLM 相关端点等）大多已提供 Responses API 兼容。切换前需逐个验证（见"行动清单"）。

## 五、成熟度对比

| | dsh | codex | pi |
|---|---|---|---|
| 版本 | 0.1.2-alpha.2 | 0.151.0 stable（2-4 天一版） | 0.84.4（4 个月 ~90 版） |
| 定位 | developer preview，官方明示破坏性变更 | OpenAI 官方生产级 | 0.x，API 未冻结 |
| 安全审计 | 未做 | — | — |
| npm 月下载 | 新项目 | — | pi-ai 1460 万 / coding-agent 831 万 |
| 迭代 | 极活跃（单月 2751 commits） | 极活跃 | 极活跃（单人主导，总线风险） |
| 测试 | 849 spec + 166 e2e | 大规模 Rust 测试 + CI | 大规模 vitest |

## 六、结论与建议

### 排序

1. **pi — 首选候选**（SDK 嵌入路线）
   - 命中我们最多核心痛点：同进程嵌入（消灭子进程生命周期整类 bug——AtomCode 崩溃卡 busy、SSE 挂死、exit 兜底看门狗等历史问题在进程内模型下根本不存在）；`steer/followUp` 队列语义强于现有单槽；GLM/DeepSeek/Anthropic 全内置；CLAUDE.md 与 `~/.claude/skills` 直接兼容。
   - 缺口有明确补法：memory/todo/plan/MCP/权限门全走 extension（官方 60+ 示例含 permission-gate、subagent、plan-mode、todo），这些恰好是 bridge 场景里可自控的层。
   - 主要代价：0.x 高频 breaking change（锁版本 + 升级窗口策略）、无内置沙箱（需要容器或扩展软门）、单人主导项目。
2. **codex — 条件可行，值得跟进**（app-server 直连路线）
   - 优势：生产级成熟度、审批协议结构化程度最高（requestApproval 请求/应答，天然映射飞书审批卡）、**唯一有全自动跨会话 memory**、`external-agent-migration` 可直接迁移 Claude Code 的 config/MCP/hooks/memory/sessions。
   - 前提：验证我们常用服务商的 `/v1/responses` 端点（见行动清单）；`app-server` 协议 churn 快（stable 2-4 天一版），需锁版本跟进。
   - 不走 ACP 适配器，直连 app-server（避免为统一而统一多一跳）。
3. **dsh — 保持观察**
   - 功能最全（工具面、goal 长任务、ACP 原生），且 LLM 层就是 pi-ai，等于"功能更全但更不成熟的 pi 全家桶"。
   - alpha 阶段 + 无安全审计，等 0.2+ 稳定后再评估。届时若 pi 迁移顺利，dsh 的 ACP 路线反而可作为多基座抽象的统一协议选项。

### 行动清单（PoC 前置验证）

1. **验证 codex 模型接入**（一天内可完成）：
   - `codex login` 或 config.toml 配自定义 `[model_providers.X]`（`wire_api = "responses"`）
   - 逐一验证常用端点的 `/v1/responses`：Anthropic、GLM CodingPlan、AtomGit 端点
   - 验证通过 → codex 升级为与 pi 并列的 PoC 候选
2. **pi PoC**（若走首选路线）：
   - bridge 加第三种 backend `"pi"`：`createAgentSession()` 嵌入，`subscribe` 的 `message_update` → 飞书 streaming card，`abort()` → `/interrupt`，`SessionManager` → 会话持久化
   - 与现有 claude/atomcode 后端并存灰度，跑一个测试项目
   - 验证三大链路：飞书流式卡 + interrupt + 会话跨 bridge 重启恢复
3. **升级依赖确认**：pi 要求 Node ≥ 22.19，确认本机 bridge 运行时版本

### 架构演进方向

无论最终选 pi 还是 codex，`ProjectManager` 的双异构后端（ClaudeProcess + AtomCodeDaemon）都可以收敛为单一基座多 provider 路由，bridge 侧代码量预计显著缩减。若未来要多基座并存（如 Claude + pi + codex），优先考虑以 ACP 为统一抽象协议（dsh 原生、codex 有官方适配器、pi 需自包一层）。

---

---

## 七、决策与落地（2026-09-02 补记）

### 决策：选 Codex，feat/dsh 分支整体切换

用户决策：这是生产系统，不折腾。Claude Code 对第三方模型封闭且有负优化；成熟度最理想的替代就是 Codex。需求收敛为"把 Codex CLI（仅 CLI，不含 desktop/web）的 IO 完整桥接到飞书"，思路与当初 AtomCode 改造一致。

落地范围（本分支）：

- 后端单一化为 `CodexAppServer`（`codex app-server`，JSON-RPC over stdio），移除 ClaudeProcess / AtomCodeDaemon；
- 每项目独立 Provider：`thread/start` 原生支持 `model` + `modelProvider` 参数，`bridge.json` 按项目配置（不复杂，直接做掉）；
- 跨会话记忆：codex 内置两阶段 memory 管线（`[features] memories = true`，Stable），**替代 server-memory MCP**；
- `claude_enhance/` 与 AtomCode DLC 脚本从本分支移除（codex 有自己的 skills/AGENTS.md 生态）。

### 实测验证结论（2026-09-02，codex-cli 0.152.1）

1. **模型接入**：本机网关（阿里云 MaaS token-plan）的 `/compatible-mode/v1/responses` 端点可用，`glm-5.2` 实跑通过。`/v1/responses`（anthropic 路径）不存在，Responses 端点挂在 `compatible-mode` 路径下——**接入前必须探测实际路径**。
2. **沙箱**：本机 `kernel.apparmor_restrict_unprivileged_userns = 1`，bubblewrap 起不来（`bwrap: loopback: Failed RTM_NEWADDR`）→ 生产配置定为 `danger-full-access` + `approval never`（与旧 `--dangerously-skip-permissions` 姿态一致）。
3. **协议全链路**：initialize → thread/start（带 model/modelProvider/sandbox 覆盖）→ turn/start → `item/agentMessage/delta` 增量 → `thread/tokenUsage/updated` → `turn/completed`，以及跨进程 `thread/resume`（`excludeTurns: true`）+ 上下文连续性，全部实测通过；后端类 19 项端到端断言全绿（含打断、并发守卫、工具执行、崩溃恢复语义）。
4. **模型元数据**：`glm-5.2` 无内置元数据（警告级），用 `model_context_window` 显式声明上下文窗口规避。
5. **版本纪律**：codex stable 2-4 天一版、app-server 协议 churn 快——`EXPECTED_CODEX_VERSION` 钉住基线版本，升级需重跑验证。

## 附：关键证据文件索引

### dsh（`/home/wukong/codes/deepseek-harness`，0.1.2-alpha.2）

- 入口模式：`apps/cli/README.md`（Entry modes 表）、`apps/cli/src/args.ts`
- ACP：`packages/acp/acp/{README.md,src/index.ts}`（session/resume、cancel、request_permission）
- SDK：`packages/sdk/client/{README.md,src/api.ts}`（Known Limitations：无 mid-turn cancel、无跨进程 resume）
- 会话持久化：`packages/session/session-persistence-jsonl/`、`docs/subsystems/persistence.md`
- 指令注入：`packages/context/agent-instructions/`
- memory：`docs/user/guide/mcp-memory.md`（默认关闭，外挂 MCP）
- compaction：`packages/compaction/compaction-basic/`
- skills：`packages/skill/{skill,skill-filesystem,tool-skill}`
- hooks 兼容桥：`packages/hooks/hooks-claude-code/`
- LLM：`packages/llm/llm-pi-ai/`（pi-ai adapter）、`docs/user/guide/providers.md`

### codex（`/home/wukong/codes/codex`）

- exec：`codex-rs/exec/src/{cli.rs,exec_events.rs,lib.rs}`（无 delta；默认 approval Never + read-only）
- app-server：`codex-rs/app-server-protocol/src/protocol/common.rs`（100+ 方法：thread/turn/item、requestApproval、delta 通知）
- 工具注册：`codex-rs/core/src/tools/spec_plan.rs:985`（add_core_tool_sources）
- 模型接入：`codex-rs/model-provider-info/src/lib.rs:57`（CHat wire 移除报错）、config.toml `[model_providers]`
- memory：`codex-rs/memories/README.md`（两阶段管线）
- skills/hooks：`codex-rs/skills/`、`codex-rs/hooks/src/lib.rs`
- 迁移：`codex-rs/external-agent-migration/`
- ACP 适配器：npm `@agentclientprotocol/codex-acp`

### pi（`/home/wukong/codes/pi`，0.84.4）

- CLI 模式：`packages/coding-agent/src/cli/args.ts`（-p/--mode json/rpc、--session-id）
- SDK：`packages/coding-agent/docs/sdk.md`、`examples/sdk/01..13`、`src/core/agent-session.ts`
- RPC 协议：`packages/coding-agent/docs/rpc.md`（steer/followUp/abort）
- 会话：`docs/session-format.md`（JSONL 树形 v3）
- compaction：`docs/compaction.md`
- skills：`docs/skills.md`（agentskills.io）
- extensions：`docs/extensions.md`、`examples/extensions/`（60+ 示例）
- 无内置权限/MCP 声明：`docs/usage.md:309`、`docs/security.md`、`docs/containerization.md`
- GLM provider：`packages/ai/src/providers/zai-coding-cn.ts`
- chat 集成参考：github.com/earendil-works/pi-chat（Discord/Telegram，Gondolin 微虚拟机）
