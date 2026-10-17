---
name: weicoz-harness-notify
description: 使用 harness-notify 安装、配置和验证 Codex、Claude Code、DSH、Antigravity (AGY) 的完成通知，或排查 Bark、Telegram、飞书 CLI、ntfy 推送问题。适用于任务结束推送、按 harness 选择渠道或接收人、通知路径与摘要设置；不用于业务提醒、群发运营或调整代理。
---

# Harness 完成通知

使用现有 `harness-notify` 命令，按 harness 路由到 Bark、Telegram、飞书 CLI、ntfy。标题显示 harness 名称与会话窗口名称；正文只保留完整工作路径与完成摘要，不重复展示 harness 和会话 ID。摘要取最终回复摘录，最多 1000 个 Unicode 字符；不额外调用模型生成摘要。

## 找到当前实现

先运行 `command -v harness-notify`、`harness-notify --help`。尚未安装时，在用户指定目录克隆 [harness-notify](https://github.com/Weicoz/harness-notify)，运行 `node scripts/install.mjs`。需要 Node.js 22+；飞书还需已登录的 `lark-cli`，其他两渠道不需要 CLI。

命令是 `~/.local/bin/harness-notify` 到仓库的软链；通过真实路径找到源码。修改前读该仓库 README、相关实现和调用方。仓库或 Node 路径变化时核对已写入的 hook，不猜旧路径。

## 配置与接入

检查现有配置与 hook，不输出凭据。默认配置 `~/.config/harness-notify/config.json`，支持 `--config`、`HARNESS_NOTIFY_CONFIG`、`XDG_CONFIG_HOME`。不存在时运行 `harness-notify init`；初始化默认关闭通知，不覆盖文件。

按本次授权选择渠道、接收目标及 harness。修改前备份私有配置、核对 diff，保留无关字段、已有渠道与路由；私有配置权限保持 `600`。

| 内容 | 配置要点 |
|---|---|
| 全局开关 | `enabled: true` 才真实发送 |
| 完成摘要 | 用户要求摘要时设 `includeSummary: true`；否则保留原设置，默认 `false` |
| 路由 | `routes.codex`、`routes.claude`、`routes.dsh`、`routes.agy` 是渠道名称数组；`[]` 关闭对应路由 |
| 多接收人 | 在 channels 建不同名称的同类型渠道，再加入路由 |
| 其他 harness | `routes[NAME]` 或 `routes["*"]`；路由键区分大小写 |
| Bark | `type: "bark"`、server 为服务器根地址、deviceKey 为设备 key |
| ntfy | type 为 ntfy、server 根地址、topic；token 可选，使用 Bearer；配置了 token 但值缺失不回退匿名 |
| Telegram | `type: "telegram"`、botToken、chatId；接收用户需先联系 Bot |
| 飞书 | `type: "feishu"`、identity 为 user 或 bot；userId（ou_...）与 chatId（oc_...）只能填一个；cli 可为绝对路径 |

Bark 完整地址在本地解析服务器与 key；带 key 的地址是凭据，不作为公开网页抓取。凭据直接存私有 JSON 或使用 `env:变量名`。桌面进程不保证继承终端环境变量；缺变量时不回退到其他凭据或接收人。

```bash
harness-notify send --harness codex --message '通知链路测试' --dry-run
harness-notify install-hooks --dry-run
# 已获本次接入授权后执行，保留已有 hooks，并生成本地备份
harness-notify install-hooks --apply
```

install-hooks 默认覆盖四套 harness（Codex、Claude Code、DSH、AGY）。可使用 `--harness NAME` 仅接入或检查指定 harness（如 `install-hooks --harness agy --dry-run` / `--apply`），避免无授权或不兼容修改其他 harness。

| Harness | 接入方式与边界 |
|---|---|
| Codex | config.toml 的 notify，在 agent-turn-complete 传 JSON 参数。保留原 notify：adapters/codex-notify.mjs 串联，原命令数组存私有 codex-forward.json；复杂 TOML 不猜改。 |
| Claude Code | settings.json 的 hooks.Stop，JSON 经 stdin。保留其他 hooks，不用 SubagentStop 替代主任务。Stop 可能被其他 hook 要求续跑，通知不等价于业务最终验收。 |
| DSH | 全局 cordis.patch.yml 插入 adapters/dsh.mjs，监听提交后的 session/event → turn/end，仅通知 reason.kind: completed 主会话；核对过 DSH 0.2.0-rc.2。 |
| Antigravity (AGY) | ~/.gemini/config/hooks.json 的 Stop，经 stdin 接收。自动从 conversation_summaries.db 提取标题并从 transcript 解析摘要，过滤子 agent；保留已有其他 hooks。 |

## 各 Harness 接入注意事项

- **Antigravity (AGY)**：
  - **保留已有 Hook**：配置文件为 `~/.gemini/config/hooks.json`，在顶层加入 `"harness-notify": { "Stop": [...] }`。必须保留同文件已有其他 hook 组（如 `coding-agents`、`herdr`），禁止整体覆盖或破坏原有配置。
  - **单 Harness 隔离接入**：使用 `harness-notify install-hooks --harness agy --apply`，仅修改 AGY 配置，完全不触碰 Codex、Claude 或 DSH。
  - **事件与协议**：AGY 的 Stop Hook 在会话结束时通过 `stdin` 传入 JSON 元数据（含 `conversationId`、`transcriptPath`、`workspacePaths`）。`harness-notify hook` 执行完毕以 exit 0 退出且 stdout 保持为空，AGY 正常结束流程，不阻断运行。
  - **会话标题读取**：AGY 会话标题持久化在 `~/.gemini/antigravity-cli/conversation_summaries.db`（SQLite）。适配器优先使用 `sqlite3 -json` 提取对应 `conversationId` 的标题；若系统未安装 sqlite3 或数据库不可读，自动安全降级为未命名会话，绝不根据其他会话盲猜。
  - **回复摘要提取**：从 `transcript.jsonl`（及截断时的 `transcript_full.jsonl`）中提取，必须严格匹配 `type === 'PLANNER_RESPONSE'`（排除 `GENERIC` 工具回包），确保摘要是真实的最终模型答复，而非中间工具输出。
  - **子 Agent 过滤**：AGY 派生子任务（`nesting_depth > 0`、`parent_conversation_id` 或 `source: "subagent"`）会自动静默忽略，避免后台子任务结束引发重复通知。
- **Codex**：
  - `config.toml` 的 notify 必须保留原程序串联。若已有其他工具包装（如 SkyComputerUseClient），通过 `--harness codex` 独立安装或手工串联，不得清除原命令。
- **Claude Code**：
  - `settings.json` 的 `hooks.Stop` 通过 stdin 传入。Stop 事件发生在其他 hook 续跑决策之前；多次续跑由最终 Stop 通知，子 agent（带 `agent_id`）自动过滤。
- **DSH**：
  - 适配器针对主会话 `turn/end` 且 `reason.kind === 'completed'` 触发，自动过滤子 agent。用 `dsh --profile NAME --dump-config` 查合成配置，不启动服务；Desktop profile 由 Electron 独占管理。

## 开源规范与安全边界

本技能面向公开开源仓库（GitHub [harness-notify](https://github.com/Weicoz/harness-notify)）设计，必须遵循通用安全与可移植性规范：

- **严禁硬编码敏感凭据**：任何 Token、密码、私人 Webhook、DeviceKey、Chat ID 或特定机器的绝对路径（如 `/Users/xxx`）严禁写入本技能、文档、代码或 Git 提交。所有凭据仅存在于本地私有配置文件 `~/.config/harness-notify/config.json`（权限保持 `600`，且已通过 `.gitignore` 排除），或使用 `env:变量名` 从本地环境变量读取。
- **预演模式优先**：验证配置与逻辑时使用 `--dry-run`；预演模式绝不发起外网 HTTP 请求、不执行飞书 CLI、不落盘状态文件，且输出已自动脱敏，不回显真实密钥。
- **状态与去重安全**：状态回执保存在 `~/.local/state/harness-notify/`（权限 `600`），仅记录哈希去重键、渠道名、消息 ID 和脱敏错误信息，绝对不保存用户消息正文、路径或凭据。
- **窗口名称**：优先取 hook 的 session_title；Codex 按精确 ID 读 session_index.jsonl，Claude 取 transcript 自定义标题或自动生成标题（自定义优先），DSH 取最新 session/title，Antigravity 取 SQLite conversation_summaries.db。读不到时显示未命名会话，不按目录、时间或最近窗口猜名称；手动发送可用 --session-title。

## 验证与发送

沿用已有授权。未授权发送或目标未确定时停在 dry-run；用户要求测试时，对明确目标只发一次固定消息。dry-run 不访问网络、不调用飞书 CLI、不写状态；ready: true 只代表配置可解析，不证明登录、网络或送达。

```bash
harness-notify send --harness codex --message '通知链路测试' --event-id '本次测试唯一ID'
```

按实际完成范围报告：

- send 成功只验证渠道 API；Bark accepted: true 不证明手机显示。
- 人工传 JSON 给 hook 只验证协议，不能称真实 harness 自动触发。
- 新会话完成一轮才验证原生完成事件与自动推送；使用最小无工具任务。DSH 可用 `dsh headless --json '通知测试；不用工具，只回复测试成功'`，这是一次真实模型调用。
- 旧会话是否重载单独核对；新进程成功不能证明已运行的 Web/TUI/Desktop 已加载，避免打断已有任务。
- 手机显示仅凭用户确认或设备证据报告，不把 API 接受当设备送达。

默认回执在 `~/.local/state/harness-notify/`，支持 `--state-dir` / `HARNESS_NOTIFY_STATE_DIR`。核对本次具体事件，不把其他会话的新回执当成功。回执不存正文或凭据；hook stdout 为空且失败仍退出 0，要检查 stderr 和回执。

## 排障与维护

- 没通知：核对 route、enabled、渠道配置/环境变量、hook 唯一性、harness 重载及本次回执。路径来自 hook 的 cwd；手动 send 用命令当前目录。
- 超时、非 JSON、飞书回读失败：保留尝试记录，先查结果，不自动重试。同一事件及渠道会去重；确认未送达且获补发授权后才用新 event-id，不清空整个状态目录。
- 飞书：发送返回消息 ID 后，以相同身份 messages-mget 回读，验证 ID、正文、deleted: false；CLI exit 0 不单独证明送达。
- 原 Codex 通知失败：检查私有转发配置和原可执行文件，不删除原通知；新程序失败也不阻断原程序或 agent。
- 改代码：复用 Node 标准库和共享格式化逻辑，跑相称的 npm test、npm run check、diff 检查。发布前检查 staged 文件没有真实配置、key、接收人、状态和日志。提交发布按用户授权。
- 改技能：解析 ~/.agents/skills/weicoz-harness-notify 的真实源，修改唯一维护源。仓库 skills/weicoz-harness-notify 是可分发副本，发布时同步、核对一致，不作为第二个独立维护源；保持 weicoz- 名称。

交付说明 harness/渠道、备份、自动触发/API/设备各层结果、重载或 profile 阻塞。不重复询问已授权动作，不添加其他渠道、常驻 HTTP 服务、群发或自动清理。
