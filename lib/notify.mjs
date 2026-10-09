import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);
const digest = text => createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (text, max) => Array.from(String(text)).slice(0, max).join('');

export function normalize(harness, payload) {
  if (!object(payload)) throw new Error('hook 输入必须是 JSON 对象');
  if (payload.type && payload.type !== 'agent-turn-complete') return null;
  if (payload.hook_event_name && payload.hook_event_name !== 'Stop') return null;
  // 通知 hook 不请求续跑；续跑后的最终 Stop 也需通知。子 agent 单独过滤。
  if (payload.agent_id) return null;
  const session = payload['thread-id'] ?? payload.session_id ?? '';
  const turn = payload['turn-id'] ?? payload.turn_id ?? payload.prompt_id ?? '';
  const summary = payload['last-assistant-message'] ?? payload.last_assistant_message ?? '';
  const cwd = payload.cwd ?? '';
  for (const item of [session, turn, summary, cwd]) {
    if (typeof item !== 'string') throw new Error('hook 的会话、轮次、正文、目录字段必须是字符串');
  }
  if (!session && !turn && !summary) throw new Error('hook 缺少事件身份或最终回复');
  // shortcut: 旧 Claude 未提供可读 transcript/轮次 ID 时，完全相同回复会去重；上游支持 prompt_id 后直接使用它。
  if (harness === 'claude' && !turn && !summary) throw new Error('Claude Stop 缺少 last_assistant_message');
  return { harness, session, turn, summary, cwd, eventId: digest(JSON.stringify([harness, session, turn, turn ? '' : summary])) };
}

export async function enrichClaude(payload) {
  if (payload.turn_id || payload.prompt_id || typeof payload.transcript_path !== 'string') return payload;
  let file;
  try {
    file = await open(payload.transcript_path, 'r');
    const { size } = await file.stat();
    const bytes = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(bytes);
    await file.read(buffer, 0, bytes, size - bytes);
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const content = row.message?.content;
      if (row.type === 'user' && typeof row.uuid === 'string' && (typeof content === 'string' || Array.isArray(content) && content.some(b => b.type === 'text'))) return { ...payload, turn_id: row.uuid };
    }
  } catch { /* 不回显 transcript 路径或正文；无可读轮次 ID 则用摘要去重。 */ }
  finally { await file?.close(); }
  return payload;
}

function resolve(value, env) {
  if (typeof value === 'string' && value.startsWith('env:')) return env[value.slice(4)] ?? '';
  return value;
}

function required(value, name) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new Error(`缺少 ${name}`);
  return String(value);
}

function serverURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('渠道 server 必须是有效 URL'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('渠道 server 必须使用 HTTPS（本机测试除外）');
  if (url.username || url.password || url.search || url.hash) throw new Error('渠道 server 不允许凭据、查询参数、片段');
  return url.href.replace(/\/$/, '');
}

export function plan(config, event, env = process.env) {
  if (!object(config) || typeof config.enabled !== 'boolean' || !object(config.channels) || !object(config.routes)) throw new Error('配置需要 enabled、channels、routes');
  if (config.includeSummary !== undefined && typeof config.includeSummary !== 'boolean') throw new Error('includeSummary 必须是布尔值');
  const timeoutMs = config.timeoutMs ?? 8000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new Error('timeoutMs 必须在 100–15000 之间');
  const route = config.routes[event.harness] ?? config.routes['*'] ?? [];
  if (!Array.isArray(route) || route.some(id => typeof id !== 'string')) throw new Error('routes 的值必须是渠道名称数组');
  const harnessName = { codex: 'Codex', claude: 'Claude Code', dsh: 'DSH' }[event.harness] ?? event.harness;
  const title = `${harnessName} · 一轮任务结束`;
  const summary = event.message ?? (config.includeSummary ? event.summary?.trim() || '未提供最终回复，请回到 harness 查看结果。' : '摘要未启用，请回到 harness 查看结果。');
  const body = [`Harness：${harnessName}`, `路径：${event.cwd || process.cwd()}`, event.session ? `会话：${short(event.session, 80)}` : '', `完成摘要：${short(summary, 1000)}`].filter(Boolean).join('\n');
  const text = short(`${title}\n${body}`, 3800);
  const deliveries = [...new Set(route)].map(id => {
    const raw = config.channels[id];
    if (!object(raw)) throw new Error(`渠道 ${id} 不存在`);
    const channel = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v, env)]));
    let error;
    try {
      if (channel.type === 'telegram') {
        channel.botToken = required(channel.botToken, 'botToken');
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(channel.botToken)) throw new Error('botToken 格式错误');
        channel.chatId = required(channel.chatId, 'chatId');
        channel.server = serverURL(channel.server ?? 'https://api.telegram.org');
      } else if (channel.type === 'bark') {
        channel.deviceKey = required(channel.deviceKey, 'deviceKey');
        channel.server = serverURL(channel.server ?? 'https://api.day.app');
        if (channel.group !== undefined) channel.group = required(channel.group, 'group');
      } else if (channel.type === 'feishu') {
        channel.cli = required(channel.cli ?? 'lark-cli', 'cli');
        if (!['user', 'bot'].includes(channel.identity)) throw new Error('identity 必须是 user 或 bot');
        if (!!channel.userId === !!channel.chatId) throw new Error('userId、chatId 必须且只能填写一个');
        required(channel.userId ?? channel.chatId, '接收人');
      } else throw new Error('未知渠道类型');
    } catch (e) { error = e.message; }
    return { id, channel, error };
  });
  return { enabled: config.enabled, timeoutMs, title, body, text, eventId: event.eventId, deliveries };
}

export function preview(p) {
  return { dryRun: true, enabled: p.enabled, title: p.title, body: p.body, channels: p.deliveries.map(d => ({ id: d.id, type: d.channel.type, ready: !d.error, ...(d.error ? { error: d.error } : {}) })) };
}

async function post(url, body, timeoutMs, fetchFn) {
  let response;
  try {
    response = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch { throw new Error('网络请求失败或超时，发送结果未知；未自动重试'); }
  if (!response.ok) throw new Error(`推送 API HTTP ${response.status}；未自动重试`);
  try { return await response.json(); } catch { throw new Error('推送 API 返回非 JSON，发送结果未知'); }
}

async function runCLI(cli, args, timeoutMs, execFn) {
  let out;
  try { out = await execFn(cli, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }); }
  catch { throw new Error('飞书 CLI 执行失败或超时；请检查本地 CLI 登录和权限，未自动重试'); }
  let result;
  try { result = JSON.parse(out.stdout); } catch { throw new Error('飞书 CLI 返回非 JSON，发送结果未知'); }
  if (result.ok === false || (result.code !== undefined && result.code !== 0)) throw new Error('飞书 CLI API 失败；请检查登录、接收人和权限');
  return result;
}

export async function deliver(p, d, { fetchFn = fetch, execFn = exec } = {}) {
  const c = d.channel;
  if (c.type === 'telegram') {
    const result = await post(`${c.server}/bot${c.botToken}/sendMessage`, { chat_id: c.chatId, text: p.text }, p.timeoutMs, fetchFn);
    if (result.ok !== true || result.result?.message_id === undefined) throw new Error('Telegram 未返回成功消息 ID');
    return { messageId: result.result.message_id, accepted: true };
  }
  if (c.type === 'bark') {
    const result = await post(`${c.server}/push`, { device_key: c.deviceKey, title: p.title, body: short(p.body, 3000), group: c.group ?? 'harness' }, p.timeoutMs, fetchFn);
    if (result.code !== 200) throw new Error('Bark 未返回成功状态');
    return { accepted: true };
  }
  const result = await runCLI(c.cli, ['im', '+messages-send', '--as', c.identity, c.userId ? '--user-id' : '--chat-id', String(c.userId ?? c.chatId), '--text', p.text, '--idempotency-key', digest(`${p.eventId}:${d.id}`).slice(0, 50), '--json'], p.timeoutMs, execFn);
  const messageId = result.data?.message_id ?? result.message_id;
  if (typeof messageId !== 'string' || !messageId.startsWith('om_')) throw new Error('飞书未返回消息 ID，发送结果未知');
  const readback = await runCLI(c.cli, ['im', '+messages-mget', '--as', c.identity, '--message-ids', messageId, '--no-reactions', '--json'], p.timeoutMs, execFn);
  const messages = readback.data?.messages ?? readback.messages ?? [];
  const message = messages.find(m => m.message_id === messageId);
  let text;
  try { text = JSON.parse(message?.body?.content ?? '{}').text; } catch { /* 下方统一验证 */ }
  if (!message || message.deleted !== false || text !== p.text) throw new Error('飞书已返回消息 ID，但回读校验失败；未自动重发');
  return { messageId, accepted: true, verified: true };
}

export async function send(p, stateDir, deps = {}) {
  if (!p.enabled) return { skipped: '通知未启用', results: [] };
  const invalid = p.deliveries.find(d => d.error);
  if (invalid) throw new Error(`渠道 ${invalid.id}：${invalid.error}`);
  if (!p.deliveries.length) return { skipped: '该 harness 未配置渠道', results: [] };
  const results = [];
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const d of p.deliveries) {
    const receipt = join(stateDir, `${digest(`${p.eventId}:${d.id}`)}.json`);
    let handle;
    try { handle = await open(receipt, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw new Error('通知状态目录不可写');
      results.push({ channel: d.id, skipped: '同一事件已尝试发送' });
      continue;
    }
    // 先保留尝试记录，超时或进程崩溃后也不重复产生外部副作用。
    try { await handle.writeFile(JSON.stringify({ status: 'attempting', at: new Date().toISOString() })); }
    finally { await handle.close(); }
    let result;
    try { result = { channel: d.id, ...await deliver(p, d, deps) }; }
    catch (e) { result = { channel: d.id, error: e.message }; }
    await writeFile(receipt, JSON.stringify(result), { mode: 0o600 });
    results.push(result);
  }
  return { results };
}
