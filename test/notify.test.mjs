import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { normalize, enrichClaude, plan, preview, send } from '../lib/notify.mjs';
import { addStop, installHooks, replaceNotify } from '../scripts/install-hooks.mjs';
import { apply, payloadFor } from '../adapters/dsh.mjs';

const exec = promisify(execFile);
const cli = new URL('../bin/harness-notify.mjs', import.meta.url).pathname;
const config = (channels, routes = { codex: Object.keys(channels) }) => ({ enabled: true, channels, routes });
const event = { harness: 'codex', session: 's', turn: 't', summary: '私有正文', cwd: '/tmp/project', eventId: 'same-turn' };
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'harness-notify-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('归一化兼容 Codex 参数及 Claude stdin，过滤非完成事件与子 agent', () => {
  const codex = normalize('codex', { type: 'agent-turn-complete', 'thread-id': 's', 'turn-id': 't', 'last-assistant-message': '完成' });
  assert.equal(codex.summary, '完成');
  assert.equal(codex.eventId, normalize('codex', { type: 'agent-turn-complete', 'thread-id': 's', 'turn-id': 't', 'last-assistant-message': '更新后的正文' }).eventId);
  const payload = { hook_event_name: 'Stop', session_id: 's', last_assistant_message: '完成' };
  assert.equal(normalize('claude', payload).summary, '完成');
  assert.notEqual(normalize('claude', payload).eventId, normalize('claude', { ...payload, last_assistant_message: '下一轮完成' }).eventId);
  assert.equal(normalize('claude', { ...payload, stop_hook_active: true }).summary, '完成');
  assert.equal(normalize('claude', { ...payload, agent_id: 'child' }), null);
  assert.equal(normalize('claude', { hook_event_name: 'PreToolUse' }), null);
  assert.throws(() => normalize('codex', []));
  assert.throws(() => normalize('claude', { session_id: 's' }));
});

test('Claude 从最近用户消息 UUID 区分相同回复的不同轮次，跳过工具结果', async t => {
  const dir = await temp(t);
  const transcript_path = join(dir, 'transcript.jsonl');
  const rows = [{ type: 'user', uuid: 'prompt-1', message: { content: '任务' } }, { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', content: '完成' }] } }];
  await writeFile(transcript_path, rows.map(row => JSON.stringify(row)).join('\n'));
  const payload = { session_id: 's', transcript_path, last_assistant_message: '完成' };
  assert.equal((await enrichClaude(payload)).turn_id, 'prompt-1');
  rows.push({ type: 'user', uuid: 'prompt-2', message: { content: '第二轮' } });
  await writeFile(transcript_path, rows.map(row => JSON.stringify(row)).join('\n'));
  assert.equal((await enrichClaude(payload)).turn_id, 'prompt-2');
});

test('路由支持 harness 差异、通配、关闭及多个接收目标；预演不包含凭据', () => {
  const c = config({ phone: { type: 'bark', deviceKey: 'env:KEY' }, tg: { type: 'telegram', botToken: 'env:TOKEN', chatId: 'env:CHAT' } }, { codex: ['phone', 'phone'], claude: [], '*': ['tg'] });
  const env = { KEY: 'PRIVATE_KEY', TOKEN: '123:PRIVATE_TOKEN', CHAT: '12345' };
  const p = plan(c, event, env);
  assert.equal(p.deliveries.length, 1);
  assert.equal(p.body.includes('私有正文'), false);
  assert.equal(JSON.stringify(preview(p)).includes('PRIVATE'), false);
  assert.equal(plan(c, { ...event, harness: 'claude' }, env).deliveries.length, 0);
  assert.equal(plan(c, { ...event, harness: 'pi' }, env).deliveries[0].id, 'tg');
  assert.equal(plan(c, event, {}).deliveries[0].error, '缺少 deviceKey');
  assert.throws(() => plan({ ...c, timeoutMs: -1 }, event));
  assert.ok(plan(config({ bad: { type: 'bark', deviceKey: 'key', server: 'http://remote.invalid' } }), event).deliveries[0].error);
});

test('Codex 与 Claude 通知包含完整路径、Harness 名称和最终回复摘要；无正文不伪造完成内容', () => {
  const c = { ...config({ phone: { type: 'bark', deviceKey: 'key' } }, { '*': ['phone'] }), includeSummary: true };
  const cwd = '/tmp/项目A/相同目录名';
  for (const [harness, name] of [['codex', 'Codex'], ['claude', 'Claude Code']]) {
    const p = plan(c, { ...event, harness, cwd, summary: '修复登录失败，检查已通过。' });
    assert.ok(p.body.includes(`Harness：${name}\n路径：${cwd}`));
    assert.ok(p.body.includes('完成摘要：修复登录失败，检查已通过。'));
    assert.equal(p.title, `${name} · 一轮任务结束`);
  }
  const empty = plan(c, { ...event, summary: '' });
  assert.ok(empty.body.includes('完成摘要：未提供最终回复'));
  const manual = plan(c, { harness: 'claude', message: '手动测试', eventId: 'manual' });
  assert.ok(manual.body.includes(`路径：${process.cwd()}`));
  assert.ok(manual.body.includes('完成摘要：手动测试'));
  const long = plan(c, { ...event, cwd, summary: '长😀'.repeat(1000) });
  assert.ok(long.body.includes(`路径：${cwd}`));
  assert.equal(Array.from(long.body.split('完成摘要：')[1]).length, 1000);
  assert.ok(long.body.endsWith('长😀'.repeat(500)));
});

test('Telegram/Bark 真实 HTTP JSON、API 成功判定、并发原子去重', async t => {
  const dir = await temp(t);
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/push' ? { code: 200 } : { ok: true, result: { message_id: 12 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const p = plan({ ...config({ phone: { type: 'bark', deviceKey: 'key', server: url }, tg: { type: 'telegram', botToken: '123:token', chatId: 'chat', server: url } }), includeSummary: true }, event);
  const results = await Promise.all([send(p, dir), send(p, dir)]);
  assert.equal(requests.length, 2);
  assert.equal(requests.find(r => r.url === '/push').body.device_key, 'key');
  assert.ok(requests.find(r => r.url === '/push').body.body.includes('Harness：Codex\n路径：/tmp/project'));
  assert.ok(requests.find(r => r.url === '/push').body.body.includes('完成摘要：私有正文'));
  assert.equal(requests.find(r => r.url.includes('sendMessage')).body.chat_id, 'chat');
  assert.equal(results.flatMap(r => r.results).filter(r => r.accepted).length, 2);
  assert.equal(results.flatMap(r => r.results).filter(r => r.skipped).length, 2);
  const receipt = (await readdir(dir))[0];
  assert.equal((await stat(join(dir, receipt))).mode & 0o777, 0o600);
});

test('全路由验证先于发送；失败未知不自动重试，不泄露外部错误或 Token', async t => {
  const dir = await temp(t);
  let calls = 0;
  const deps = { fetchFn: async () => { calls++; throw new Error('https://api.telegram.org/botPRIVATE_TOKEN'); } };
  const invalid = plan(config({ good: { type: 'bark', deviceKey: 'key' }, bad: { type: 'telegram' } }), event);
  await assert.rejects(send(invalid, join(dir, 'invalid'), deps));
  assert.equal(calls, 0);
  const p = plan(config({ phone: { type: 'bark', deviceKey: 'key' } }), event);
  const result = await send(p, join(dir, 'state'), deps);
  assert.match(result.results[0].error, /发送结果未知/);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal((await send(p, join(dir, 'state'), deps)).results[0].skipped, '同一事件已尝试发送');
  assert.equal(calls, 1);
  const apiFailure = await send({ ...p, eventId: 'new' }, join(dir, 'state'), { fetchFn: async () => ({ ok: true, json: async () => ({ code: 500, message: 'PRIVATE' }) }) });
  assert.match(apiFailure.results[0].error, /Bark 未返回成功/);
  assert.equal(JSON.stringify(apiFailure).includes('PRIVATE'), false);
});

test('飞书 execFile 无 shell 插值，返回 ID 后回读校验', async t => {
  const dir = await temp(t);
  const p = plan(config({ fs: { type: 'feishu', identity: 'user', userId: 'ou_example' } }), { ...event, message: '中文换行\n$(touch /tmp/never-created)' });
  const calls = [];
  const deps = { execFn: async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: JSON.stringify(args.includes('+messages-send') ? { ok: true, data: { message_id: 'om_example' } } : { ok: true, data: { messages: [{ message_id: 'om_example', deleted: false, body: { content: JSON.stringify({ text: p.text }) } }] } }) };
  } };
  const r = await send(p, dir, deps);
  assert.equal(r.results[0].verified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[calls[0].args.indexOf('--text') + 1], p.text);
  assert.equal(calls[0].args[calls[0].args.indexOf('--idempotency-key') + 1].length, 50);
  const bad = await send({ ...p, eventId: 'bad-readback' }, dir, { execFn: async (_, args) => ({ stdout: JSON.stringify(args.includes('+messages-send') ? { data: { message_id: 'om_example' } } : { data: { messages: [] } }) }) });
  assert.match(bad.results[0].error, /回读校验失败/);
});

test('CLI dry-run 真正无外部调用、无状态修改；hook stdout 空、错误不阻断', async t => {
  const dir = await temp(t);
  const configPath = join(dir, 'local.json');
  const state = join(dir, 'state');
  await writeFile(configPath, JSON.stringify(config({ fs: { type: 'feishu', identity: 'user', userId: 'ou_example', cli: '/does/not/exist' } })));
  const flags = ['--harness', 'codex', '--config', configPath, '--state-dir', state];
  const out = await exec(process.execPath, [cli, 'send', ...flags, '--message', '测试', '--dry-run']);
  assert.equal(JSON.parse(out.stdout).channels[0].ready, true);
  assert.deepEqual(await readdir(dir), ['local.json']);
  const hook = await exec(process.execPath, [cli, 'hook', ...flags, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 's', 'turn-id': 't' })]);
  assert.equal(hook.stdout, '');
  assert.match(hook.stderr, /飞书 CLI 执行失败/);
  const invalid = await exec(process.execPath, [cli, 'hook', ...flags, 'invalid-json']);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /不是合法 JSON/);
});

test('安装 hook 保留所有其他配置、备份、幂等；dry-run 不创建目录', async t => {
  const dir = await temp(t);
  const before = JSON.stringify({ env: { KEEP: 'yes' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }], PreToolUse: [] } });
  const merged = JSON.parse(addStop(before, 'new'));
  assert.deepEqual(merged.env, { KEEP: 'yes' });
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'existing');
  const options = { home: dir, cliPath: cli, configPath: join(dir, 'config.json') };
  assert.equal((await installHooks(options)).dryRun, true);
  assert.deepEqual(await readdir(dir), []);
  await installHooks({ ...options, apply: true });
  const claude = join(dir, '.claude/settings.json');
  await writeFile(claude, before);
  const result = await installHooks({ ...options, apply: true });
  assert.equal(await readFile(result.changes.find(c => c.harness === 'claude').backup, 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(claude)).env, { KEEP: 'yes' });
  assert.ok((await installHooks({ ...options, apply: true })).changes.every(c => !c.changed));
});

test('Codex notify 串联保留原程序及其参数，非目标 TOML 字节不变', () => {
  const raw = 'model = "test"\nnotify = [\n  "/path/with ] bracket",\n  "turn-ended",\n]\n[features]\nhooks = true\n';
  const changed = replaceNotify(raw, ['node', 'adapter']);
  assert.deepEqual(changed.previous, ['/path/with ] bracket', 'turn-ended']);
  assert.equal(changed.after, 'model = "test"\nnotify = ["node","adapter"]\n[features]\nhooks = true\n');
  assert.throws(() => replaceNotify("notify = ['literal']\n", ['node']));
});

test('Codex 适配器实际调用原通知程序并传入同一 payload，CLI stdout 保持为空', async t => {
  const dir = await temp(t);
  const oldProgram = join(dir, 'old-notify.mjs');
  const recorded = join(dir, 'recorded.json');
  await writeFile(oldProgram, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2],process.argv[3]);');
  const forward = join(dir, 'forward.json');
  const configPath = join(dir, 'disabled.json');
  await writeFile(forward, JSON.stringify([process.execPath, oldProgram, recorded]));
  await writeFile(configPath, JSON.stringify({ enabled: false, channels: {}, routes: {} }));
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 's', 'turn-id': 't' });
  const adapter = new URL('../adapters/codex-notify.mjs', import.meta.url).pathname;
  const result = await exec(process.execPath, [adapter, forward, configPath, payload]);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(await readFile(recorded, 'utf8'), payload);
});

test('DSH 仅已提交 completed 主轮次触发，正文仅取本轮最后文本', async t => {
  const session = { header: { id: 's', cwd: '/tmp/project' }, snapshotEvents: () => [{ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'thinking', text: 'secret' }, { type: 'text', text: '已完成' }] } } }] };
  const event = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } };
  assert.equal(payloadFor(session, event).last_assistant_message, '已完成');
  assert.equal(payloadFor(session, { ...event, data: { ...event.data, reason: { kind: 'aborted' } } }), null);
  assert.equal(payloadFor({ ...session, header: { ...session.header, origin: 'subagent' } }, event), null);
  assert.equal(payloadFor(session, { type: 'agent/turn-stopping' }), null);
  const dir = await temp(t);
  const configPath = join(dir, 'disabled.json');
  await writeFile(configPath, JSON.stringify({ enabled: false, channels: {}, routes: {} }));
  const handlers = {};
  const warnings = [];
  apply({ on: (name, fn) => { handlers[name] = fn; }, logger: () => ({ warn: text => warnings.push(text) }) }, { configPath });
  await handlers['session/event'](session, event);
  handlers.dispose();
  assert.deepEqual(warnings, []);
});
