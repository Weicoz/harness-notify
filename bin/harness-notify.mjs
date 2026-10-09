#!/usr/bin/env node
import { readFile, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { normalize, enrichClaude, plan, preview, send } from '../lib/notify.mjs';

const help = `harness-notify：统一任务完成推送（Bark、Telegram、飞书 CLI、ntfy；Node.js 22+）
  init                    创建私有配置，不覆盖已有文件
  send --harness NAME --message TEXT [--event-id ID] [--dry-run]
  hook --harness NAME [JSON] [--dry-run]  也可从 stdin 读取 JSON
  install-hooks [--dry-run] [--apply]    接入 Codex、Claude Code、DSH
  --config PATH           默认 ~/.config/harness-notify/config.json
  --state-dir PATH        默认 ~/.local/state/harness-notify
dry-run 不发送、不调用飞书 CLI、不写配置或状态。hook 失败仅写 stderr，不阻断 agent。
`;
const args = process.argv.slice(2);
const hook = args[0] === 'hook';
try {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    harness: { type: 'string' }, message: { type: 'string' }, 'event-id': { type: 'string' },
    config: { type: 'string' }, 'state-dir': { type: 'string' },
    'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  const configPath = values.config ?? process.env.HARNESS_NOTIFY_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'harness-notify/config.json');
  const stateDir = values['state-dir'] ?? process.env.HARNESS_NOTIFY_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'harness-notify');
  const print = data => console.log(JSON.stringify(data, null, 2));
  if (!command || values.help) console.log(help);
  else if (command === 'init') {
    if (values['dry-run']) print({ dryRun: true, configPath });
    else {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      const source = await readFile(new URL('../examples/config.json', import.meta.url));
      const file = await open(configPath, 'wx', 0o600);
      try { await file.writeFile(source); } finally { await file.close(); }
      print({ configPath, enabled: false });
    }
  } else if (command === 'install-hooks') {
    const { installHooks } = await import('../scripts/install-hooks.mjs');
    print(await installHooks({ apply: values.apply && !values['dry-run'], cliPath: fileURLToPath(import.meta.url), configPath }));
  } else if (['hook', 'send'].includes(command)) {
    if (!values.harness || !/^[a-zA-Z0-9_-]{1,40}$/.test(values.harness)) throw new Error('--harness 必须是 1–40 位字母、数字、下划线或连字符');
    let event;
    if (command === 'hook') {
      if (positionals.length > 2) throw new Error('hook 仅接受一个 JSON 参数');
      let input = positionals[1];
      if (input === undefined) {
        if (process.stdin.isTTY) throw new Error('hook 需要 JSON 参数或 stdin');
        input = '';
        for await (const chunk of process.stdin) {
          input += chunk;
          if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('hook 输入超过 1 MiB');
        }
      }
      let payload;
      try { payload = JSON.parse(input); } catch { throw new Error('hook 输入不是合法 JSON'); }
      if (values.harness === 'claude' && payload && typeof payload === 'object') payload = await enrichClaude(payload);
      event = normalize(values.harness, payload);
      if (!event) { if (values['dry-run']) print({ dryRun: true, skipped: '非主 agent 完成事件' }); }
    } else {
      if (!values.message?.trim()) throw new Error('send 需要 --message');
      event = { harness: values.harness, message: values.message, eventId: values['event-id'] ?? randomUUID() };
    }
    if (event) {
      let config;
      try { config = JSON.parse(await readFile(configPath, 'utf8')); }
      catch { throw new Error('通知配置缺失或 JSON 错误；运行 harness-notify init 后编辑本地配置'); }
      const p = plan(config, event);
      if (values['dry-run']) print(preview(p));
      else {
        const result = await send(p, stateDir);
        if (!hook) print(result);
        const failed = result.results.filter(r => r.error);
        if (failed.length) throw new Error(failed.map(r => `${r.channel}: ${r.error}`).join('；'));
      }
    }
  } else throw new Error('未知子命令；使用 --help');
} catch (e) {
  // 不回显外部响应、CLI stderr、带 Token 的 URL、输入正文。
  const message = e.code === 'EEXIST' ? '目标文件已存在，未覆盖' : e.code ? `本地操作失败（${e.code}）` : e.message;
  console.error(`harness-notify: ${message}`);
  process.exitCode = hook ? 0 : 1;
}
