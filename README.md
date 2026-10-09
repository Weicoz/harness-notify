# harness-notify

统一完成通知命令：Codex、Claude Code、DSH 的完成 hook 调用一次，按配置发送到 Bark、Telegram、飞书 CLI 或 ntfy。每个 harness 可选择不同渠道与接收人，也可同时发送多个渠道。Node.js 22+，零第三方依赖，无常驻服务。

通知包含 **harness 名称、完整工作路径、会话标识、完成摘要**。摘要取最终回复摘录，最多 **1000 个 Unicode 字符**；不额外调用模型生成摘要。一轮回复结束不代表测试、部署或业务验收成功。

## 安装

```bash
git clone https://github.com/Weicoz/harness-notify.git
cd harness-notify
node scripts/install.mjs
harness-notify init
```

命令软链位于 `~/.local/bin/harness-notify`，确保该目录在 PATH。安装器不覆盖已有其他命令；仓库需保留在当前路径。`init` 创建权限 `600` 的私有配置，默认关闭通知，不覆盖已有文件。

## 先用 Bark 跑通

在 iOS Bark App 复制推送地址，例如 `https://api.day.app/设备key/`。`server` 填服务器根地址，`deviceKey` 只填设备 key。编辑 `~/.config/harness-notify/config.json`：

```json
{
  "enabled": true,
  "includeSummary": true,
  "channels": {
    "phone": { "type": "bark", "server": "https://api.day.app", "deviceKey": "在私有配置填写设备key" }
  },
  "routes": {
    "codex": ["phone"],
    "claude": ["phone"],
    "dsh": ["phone"],
    "*": []
  }
}
```

已有配置时合并字段，保留其他渠道与路由。真实 key 不放命令行、README 或 Git。

```bash
# 无发送、无状态修改
harness-notify send --harness codex --message '通知链路测试' --dry-run
harness-notify install-hooks --dry-run
# 写入三套 hook，先备份、保留原有配置
harness-notify install-hooks --apply
# 向选中的渠道发送一次；本次测试 ID 不重复使用
harness-notify send --harness codex --message '通知链路测试' --event-id '你的唯一测试ID'
```

安装后按各 harness 的机制重载配置。脚本不杀进程、不自动重启。

通知示例：

```text
Codex · 一轮任务结束
Harness：Codex
路径：/你的项目/完整工作目录
会话：对应会话标识
完成摘要：修复登录问题，检查通过。
```

## Agent skill

附带 [weicoz-harness-notify](skills/weicoz-harness-notify/SKILL.md)，用于让 agent 安装、配置、验证、排查完成推送。skill 用于操作此工具，实际通知由 hook 触发，不会默认对每次聊天额外再发一条。

```bash
node scripts/install-skill.mjs --dry-run
node scripts/install-skill.mjs --apply
```

技能维护源放在 `~/.skills-manager/skills/weicoz-harness-notify/`，发现入口为 `~/.agents/skills/weicoz-harness-notify` 软链。脚本幂等，不覆盖不同内容或不同来源的入口。重载 harness 后可调用 `$weicoz-harness-notify`，例如“给 DSH 配置 Bark 并验证自动完成推送”。维护及分发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 渠道配置

完整无凭据示例：[examples/config.json](examples/config.json)。`channels` 中每个键是一条独立渠道；`routes` 中每个 harness 对应渠道名称数组。

| 渠道 | 字段 | 成功判定 |
|---|---|---|
| Bark | type=bark，server，deviceKey；group 可选 | API code=200 |
| Telegram | type=telegram，botToken，chatId；server 可选 | API ok=true 且返回消息 ID |
| 飞书 | type=feishu，identity=user 或 bot；userId 或 chatId 二选一，cli 可选 | 发送返回 ID，再回读校验 ID、正文、deleted=false |
| ntfy | type=ntfy，server，topic；token 可选 | 返回 message 事件、消息 ID、相同 topic |

- Telegram 用户需先与 Bot 聊天；群、频道需给予 Bot 发布权限。消息为纯文本，不解析 Markdown。
- 飞书需安装并登录 `lark-cli`。私聊 userId 为 `ou_...`，群聊 chatId 为 `oc_...`。桌面环境建议 cli 使用绝对路径。
- ntfy 手机 App 订阅的 server/topic 必须与发布配置相同，详情见下节。
- 多个接收人可创建多个同类型渠道，再放进路由；同一数组中重复渠道只发送一次。
- `[]` 关闭对应 harness；`*` 是未知 harness 的默认路由，路由键区分大小写。

开关与凭据：

| 字段 | 含义 |
|---|---|
| enabled | false 时不发送、不写发送状态 |
| includeSummary | 默认 false；true 时发送最终回复摘录，最多1000字符；缺正文时显示“未提供最终回复” |
| timeoutMs | 每次 HTTP/CLI 调用超时，默认8000，范围100–15000 |
| env:变量名 | 读取调用进程环境变量；也可直接在私有 JSON 填值 |

桌面 harness 不保证继承终端环境变量。凭据只存私有配置，保持权限 `600`；不要把真实配置、接收人、topic、Token、状态或日志加入 public 仓库。启用摘要会将最终回复摘录发到所选平台。路径取 hook 的 cwd；手动 send 使用命令当前目录。Telegram 总文本最多3800字符，Bark正文最多3000字符，ntfy正文按其默认限制最多4096个UTF-8字节（不截断半个emoji）；摘要自身最多1000字符。

## 接入 ntfy

通过 HTTP JSON 发布，不需要本机安装 ntfy CLI。手机 App 先订阅同一 server 与 topic，在私有配置的 channels 添加：

```json
{
  "ntfyPhone": {
    "type": "ntfy",
    "server": "https://ntfy.sh",
    "topic": "env:NTFY_TOPIC"
  }
}
```

自建服务填它的 HTTPS 根地址。按 [官方 JSON 发布协议](https://docs.ntfy.sh/publish/#publish-as-json)，请求 POST 到服务器根地址，topic 在正文，不将订阅地址作为 server。

需要认证时添加 `"token": "env:NTFY_TOKEN"` 或在私有文件直接填 Token。Token 在 [ntfy 网页 Account](https://ntfy.sh/account) 登录后进入 **Access tokens** 创建；它是账号发布凭据，手机“允许通知”只控制接收提醒。参考 [官方 Token 说明](https://docs.ntfy.sh/publish/#access-tokens)。配置了 token 但值缺失时在发送前失败，不自动回退匿名。

公开且未保护的 topic 名称相当于共享口令；使用难猜名称并保存在私有配置，或使用有访问控制的 topic。给请求附带 Token 不会自动把一个公开 topic 变成私有 topic；访问权限需在服务端或账号设置核对。

路由选择：

```json
{
  "codex": ["phone", "ntfyPhone"],
  "claude": ["phone", "ntfyPhone"],
  "dsh": ["phone", "ntfyPhone"]
}
```

上例同时发送 Bark 与 ntfy；仅使用 ntfy 时只保留 ntfyPhone。只改选中的 harness，原完成 hook 无需修改。目标与凭据确认后执行 dry-run，再使用一个新 event-id 发送一次测试。

自建 ntfy 的 iOS 锁屏即时推送还需配置 upstream-base-url，参考 [官方服务端说明](https://docs.ntfy.sh/config/#ios-instant-notifications)。API 接受、App 前台出现消息、锁屏实际通知分别验证。

## 命令与路径

```bash
harness-notify --help
harness-notify send --harness dsh --message '检查完成' --event-id 'session-123-turn-4' --dry-run
printf '%s' '{"type":"agent-turn-complete","session_id":"s1","turn_id":"t1","cwd":"/你的项目","last_assistant_message":"检查完成"}' \
  | harness-notify hook --harness other --dry-run
```

手动 send 未指定 event-id 时每次是新事件。hook 接收 stdin JSON 或单个 JSON 参数；harness 名称允许1–40位字母、数字、下划线、连字符。hook 默认 stdout 为空，失败写 stderr、退出0，不阻断 agent；send 失败退出1。

| 路径 | 覆盖方式 |
|---|---|
| ~/.config/harness-notify/config.json | --config、HARNESS_NOTIFY_CONFIG；默认尊重 XDG_CONFIG_HOME |
| ~/.local/state/harness-notify | --state-dir、HARNESS_NOTIFY_STATE_DIR；默认尊重 XDG_STATE_HOME |

`--dry-run` 不发送、不调用飞书 CLI、不写配置或状态；ready=true 只表示配置可解析，不证明登录、连通或送达。`--dry-run` 优先于 install-hooks 的 --apply。

## 接入方式

| Harness | 配置与触发点 |
|---|---|
| Codex | ~/.codex/config.toml 的 notify；完成后的 agent-turn-complete，通过 JSON 参数 |
| Claude Code | ~/.claude/settings.json 的 hooks.Stop，通过 stdin；仅主 agent |
| DSH | ~/.dsh/cordis.patch.yml；适配器监听提交后的 session/event → turn/end，仅 reason.kind=completed 主会话 |

安装器会先备份、保留无关配置，重复运行不添加重复 hook，不删除备份。install-hooks 会接入三套 harness；只授权改某一套时，请合并其单个入口或复用已存在的 hook。

Codex 会串联原 notify：`adapters/codex-notify.mjs` 先调用原程序，再调用统一通知；原命令数组存私有 `codex-forward.json`。两方失败互不阻断。自动处理双引号命令数组及末尾逗号；复杂 TOML 拒绝猜改。没有原 notify 时可手工设：

```toml
notify = ["/绝对路径/node", "/绝对路径/harness-notify/bin/harness-notify.mjs", "hook", "--harness", "codex"]
```

Claude 的 Stop 发生在其他 Stop hooks 续跑决策之前，可能有一次提前提示；续跑后的最终 Stop 仍可通知。默认从最近用户消息 UUID 区分轮次；旧版本无 prompt id 且 transcript 不可读时回退到会话与回复去重，不同轮次的相同回复可能只通知一次。合并到已有 settings：

```json
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"harness-notify hook --harness claude","timeout":100}]}]}}
```

DSH 适配器核对过0.2.0-rc.2事件 API，全局 patch 覆盖加载它的 profiles：

```yaml
- insert:
    - id: harness-notify
      name: /绝对路径/harness-notify/adapters/dsh.mjs
      config:
        configPath: /绝对路径/config.json
```

`dsh --profile web --dump-config`（或 dsh-tui/headless/web-safe）只查合成树，不启动服务；不要把整个含私有配置的 dump 上传。Desktop profile 由 Electron 应用独占管理，CLI 拒绝 --profile desktop 是管理边界，需在应用自身验证。旧进程是否重载单独核对；不为通知绕过版本限制或修复无关插件。

其他 harness 在完成 hook 调用 send，传稳定的 session/turn event-id，或向 hook 传上述通用 JSON。

## 验证与排障

```bash
npm test
npm run check
node scripts/install-skill.mjs --dry-run
```

本机测试无需 Token、无外部推送、无付费模型请求，涵盖 Telegram/Bark/ntfy HTTP 协议、飞书命令与回读模拟、并发去重、1000字符/emoji截断、dry-run、原通知保留和技能安装不覆盖。

2026-10-09 已验证 Codex、Claude Code、DSH headless 的真实完成事件产生 Bark 成功回执；DSH web、dsh-tui、web-safe 合成配置包含唯一通知节点。未全部验证旧 Web/TUI 会话重载、Desktop 自动触发及每条消息的手机显示。ntfy 本机协议测试不等于真实受保护 topic 或设备送达。

| 现象 | 核对内容 |
|---|---|
| 没有通知 | enabled、选中 route、环境变量、hook 是否唯一、进程重载、本次回执 |
| 飞书失败 | 同一发送身份的登录、权限、接收人；返回 ID 后回读不能省略 |
| ntfy 401/403 | 发布 Token、该账号的 topic 权限；不要回退匿名或换其他 topic |
| API成功但手机没显示 | 手机订阅地址、通知权限、后台推送；自建 iOS 核对 upstream |
| 同一事件跳过 | 发送前已保留尝试记录；先确认此前结果，不直接重发 |
| 原 Codex 通知失败 | 私有转发数组、原程序路径，不移除原通知 |

发送前验证整条路由，任一选中渠道配置无效时不发送任何渠道。网络/CLI 有界超时，没有自动重试。每个事件及渠道原子创建权限600的状态文件；只保存状态、渠道名、消息ID、脱敏错误，不保存正文和凭据。失败或崩溃后记录保留，避免结果未知时重复外部副作用。

要补发，先确认原事件未送达，再按授权使用新 event-id；不提供自动清理、自动补发。不共用去重状态的配置可用不同 state-dir。新会话自动通知需真实原生事件与回执；手动 hook 测试只证明适配协议。手机显示需用户确认或设备证据。

接口依据：[Telegram](https://core.telegram.org/bots/api#sendmessage)、[Bark](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)、[ntfy](https://docs.ntfy.sh/publish/)、[Codex](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)、[Claude](https://code.claude.com/docs/en/hooks#stop)。DSH 依据安装包 dsh-session 的事件类型与实际运行；飞书依据本机 messages-send / messages-mget 的 --help。
