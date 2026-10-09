# harness-notify

一个命令，通过 harness 的完成 hook 推送到 Telegram、飞书 CLI、iOS Bark。每个 harness 可选择不同渠道与接收人，也可同时推送多个目标。Node.js 22+，零第三方依赖，无常驻服务。

通知表示一轮回复结束，不代表代码检查、部署或业务验收成功。

## 安装

```bash
git clone https://github.com/Weicoz/harness-notify.git
cd harness-notify
node scripts/install.mjs
harness-notify init
```

`scripts/install.mjs` 在 `~/.local/bin` 创建命令软链，不覆盖已有其他命令。确保该目录位于 PATH；仓库需保留在当前路径。

## 私有配置

默认路径：`~/.config/harness-notify/config.json`。`init` 创建权限 `600` 的配置，默认 `enabled: false`，不覆盖已有文件。按需要填入渠道信息后改为 `true`。仓库只放无凭据示例：[examples/config.json](examples/config.json)。

```json
{
  "enabled": true,
  "includeSummary": false,
  "timeoutMs": 8000,
  "channels": {
    "phone": {
      "type": "bark",
      "server": "https://api.day.app",
      "deviceKey": "env:BARK_DEVICE_KEY",
      "group": "harness"
    },
    "tg": {
      "type": "telegram",
      "botToken": "env:TELEGRAM_BOT_TOKEN",
      "chatId": "env:TELEGRAM_CHAT_ID"
    },
    "feishu": {
      "type": "feishu",
      "cli": "lark-cli",
      "identity": "user",
      "userId": "env:FEISHU_USER_ID"
    }
  },
  "routes": {
    "codex": ["phone", "tg"],
    "claude": ["phone"],
    "dsh": ["feishu"],
    "*": []
  }
}
```

- `env:变量名` 从调用进程环境读取。也可把具体值直接写入上述私有配置。桌面 harness 不一定继承终端的环境变量，建议直接写私有配置或从启动环境注入。
- Telegram：创建 Bot 并先与它聊天；`botToken` 为 Bot Token，`chatId` 为私聊、群或频道 ID。使用文本消息，不解析 Markdown。
- Bark：`deviceKey` 来自 iOS Bark App 的推送地址最后一段；`server` 是服务器根地址，不能包含设备 key。支持自建 HTTPS 服务。
- 飞书：本机安装、登录 `lark-cli`；`identity` 明确选择 `user` 或 `bot`；`userId` 使用 `ou_...`，群聊改用 `chatId: "oc_..."`，两者只能填一个。`cli` 可设为完整可执行路径，便于桌面进程找到它。
- 为不同接收人创建多个同类型 channel，再按 harness 路由。相同 route 中重复 channel 只发送一次。`*` 是未知 harness 的默认路由；显式 `[]` 关闭该 harness。
- `includeSummary: false` 默认只发 harness、项目名和会话标识；设为 `true` 才发送最终回复的最多 1600 字符，不发送用户输入、思考内容或完整 transcript。
- `timeoutMs` 每次 HTTP/CLI 调用的超时，范围 `100–15000`。Telegram 总文本最多 3800 字符，Bark 正文最多 3000 字符。

不要把真实配置、Bot Token、Bark key、接收人及状态文件加入 public 仓库。启用摘要会把最终回复发到你选择的平台。

## 统一发送命令

```bash
# 预演：不访问网络、不调用飞书 CLI、不写状态
harness-notify send --harness codex --message '任务完成，请查看结果' --dry-run

# 真实推送
harness-notify send --harness codex --message '任务完成，请查看结果'

# 重复调用同一 event-id，只尝试发送一次
harness-notify send --harness dsh --message '检查完成' --event-id 'session-123-turn-4'
```

不指定 `--event-id` 时，每次手动 send 都是新事件。支持 `--config PATH` / `HARNESS_NOTIFY_CONFIG`、`--state-dir PATH` / `HARNESS_NOTIFY_STATE_DIR`，默认遵循 `XDG_CONFIG_HOME`、`XDG_STATE_HOME`。

## 一次接入三个 harness

```bash
harness-notify install-hooks --dry-run
harness-notify install-hooks --apply
```

安装器会先备份再修改；不删除备份。保留所有无关配置，重复运行不添加重复 hook。`--dry-run` 优先于 `--apply`。

| Harness | 接入位置 | 触发点 |
|---|---|---|
| Codex | `~/.codex/config.toml` 的 `notify` | `agent-turn-complete`，通过参数传 JSON |
| Claude Code | `~/.claude/settings.json` 的 `hooks.Stop` | 主 agent 的 Stop，通过 stdin 传 JSON |
| DSH | `~/.dsh/cordis.patch.yml` | 本地适配器监听已提交 `session/event` 的 `turn/end`，仅 `reason.kind: completed` |

Codex 适配器会串联原 `notify` 程序；原程序和参数存于私有 `~/.config/harness-notify/codex-forward.json`，不进入本仓库。原程序先调用，任务通知随后调用；各自失败不会阻断另一方。安装器自动处理双引号字符串数组（可带末尾逗号），复杂 TOML 不猜改。

安装后重新启动相应 harness 或按其机制重载配置；安装器不杀进程、不自动重启。DSH 适配器针对已核对的 `0.2.0-rc.2` 事件 API，挂在全局 patch，覆盖加载该 patch 的 profiles。既有插件若使 profile 无法启动，需要另行修复，不要为通知绕过版本限制。

Claude 的 Stop 位于其他 Stop hook 的续跑决策之前，因此其他 hook 阻止结束时可能收到一次提前通知；续跑后的最终 Stop 仍可通知。它不等价于业务最终完成。默认用最近用户消息 UUID 区分轮次；旧版本既没有 prompt id、又无法读取 transcript 时，回退为会话与最终回复去重，此时不同轮次的完全相同回复可能只通知一次。

## 手工 hook 与其他 harness

Codex 无既有 `notify` 时可直接配置：

```toml
notify = ["/绝对路径/node", "/绝对路径/harness-notify/bin/harness-notify.mjs", "hook", "--harness", "codex"]
```

有既有 `notify` 时，请保留原程序。可手工将原字符串数组存成私有 `codex-forward.json`，再把 `notify` 设为 Node、`adapters/codex-notify.mjs`、转发配置路径、通知配置路径构成的字符串数组。

Claude Code 的 Stop 配置（合并到已有 hooks，不替换整个 settings）：

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "harness-notify hook --harness claude",
        "timeout": 100
      }]
    }]
  }
}
```

DSH 的全局或 profile patch：

```yaml
- insert:
    - id: harness-notify
      name: /绝对路径/harness-notify/adapters/dsh.mjs
      config:
        configPath: /绝对路径/config.json
```

其他 harness 只需在完成 hook 中调用 `send --harness NAME --message TEXT --event-id UNIQUE_TURN_ID`，或向 `hook` 传通用 JSON：

```bash
printf '%s' '{"type":"agent-turn-complete","session_id":"session-1","turn_id":"turn-1","last_assistant_message":"检查完成"}' \
  | harness-notify hook --harness other --dry-run
```

自定义 harness 名称仅接受 1–40 位字母、数字、下划线或连字符。JSON 可经 stdin 或单个命令行参数输入。`hook` 不向 stdout 输出协议内容；错误写 stderr，退出 `0`，不阻断 harness；`send` 失败退出 `1`。

## 送达、去重和故障边界

发送前校验整条路由，任一渠道缺配置时不发送任何渠道。网络/CLI 用有界超时，没有自动重试。Telegram 检查消息 ID；Bark 检查 API `code: 200`；飞书发送后通过 `+messages-mget` 校验 ID、正文与 `deleted: false`。API 接受推送不证明手机已显示或人已阅读。

默认状态：`~/.local/state/harness-notify/`，每个事件及 channel 一个原子占用文件，权限 `600`。发送前写尝试记录，超时、进程崩溃、回读失败时保留记录；同一事件再次调用会跳过，避免结果未知时重复通知。状态文件只含状态、渠道名、消息 ID、脱敏错误，不保存正文或凭据。

要人工补发，先确认原事件没有送达，再手动使用新的 `--event-id`；不提供自动清理或自动补发。不同配置的事件去重状态需要独立时，指定不同 `--state-dir`。迁移仓库路径、Node 路径或配置路径后，核对并重新接入 hooks。

## 验证

```bash
npm test
npm run check
```

测试包含本机 HTTP server 的真实 Telegram/Bark 请求、飞书命令协议与回读模拟、并发去重、dry-run 无副作用、hook 合并及 Codex 原通知保留。无需 Token，无外部推送，无付费模型请求。真实第三方送达与 harness 的真实完成事件需在配置后另验。

接口依据：[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)、[Bark 官方教程](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)、[Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)、[Claude hooks](https://code.claude.com/docs/en/hooks#stop)。DSH 事件依据其安装包 `@deepseek-ai/dsh-session/lib/types/index.d.ts` 与 `types/types.d.ts`，飞书依据本机 `lark-cli im +messages-send --help` / `+messages-mget --help`。
