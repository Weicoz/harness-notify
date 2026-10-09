# 贡献与发布

使用 Node.js 22+；没有第三方依赖、构建步骤或常驻服务。共享路由、消息格式、渠道发送在 lib/notify.mjs；hook 协议在 bin 与 adapters；安装与配置合并在 scripts。

修改时读调用方与现有测试。新渠道先检查官方发布协议，复用共享格式、超时、去重和脱敏；接收目标与身份由私有配置指定。保持 dry-run 无外部调用、无状态修改，未知发送结果不自动重试。

```bash
npm test
npm run check
git diff --check
```

测试使用本机 HTTP server 和飞书协议模拟，不需要真实凭据。真实模型/渠道验证单独执行，先明确接收目标与授权，不把测试夹具写进生产配置。

## 技能维护

用户级入口是 ~/.agents/skills/weicoz-harness-notify，先解析真实路径。默认维护源是 ~/.skills-manager/skills/weicoz-harness-notify；仓库 skills/weicoz-harness-notify 是发布副本，不独立编辑成另一份维护源。

修改唯一源后，将 SKILL.md 与 agents/openai.yaml 同步到发布副本，并核对内容一致。源所在的技能仓库只 stage 本技能目录，不使用 git add -A；已经 staged 的无关变更不随本次提交。第三方安装器遇到内容不同会拒绝覆盖，应先审查本地 diff。

## 发布范围

GitHub 仓库可包含源码、无凭据示例、测试、README、skill 与许可证。真实 JSON、Bark key、Telegram/ntfy Token、topic、接收人、回执、日志、配置备份只留本地，不加入 Git。

提交前核对 git diff --cached 与相关检查；提交、推送、发布仅按本次授权。提交描述使用中文。API接受、自动hook触发、手机显示分开报告，未验证的运行态不标成完成。
