import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';

const exec = promisify(execFile);
const digest = text => createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (text, max) => Array.from(String(text)).slice(0, max).join('');
function shortUtf8(text, maxBytes) {
  let result = '', size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes) break;
    result += char;
    size += bytes;
  }
  return result;
}

export function normalize(harness, payload) {
  if (!object(payload)) throw new Error('hook 输入必须是 JSON 对象');
  const hasCustomContent = Boolean(payload.title || payload.body || payload.message || payload.text);
  if (!hasCustomContent) {
    if (payload.type && payload.type !== 'agent-turn-complete') return null;
    if (payload.hook_event_name && payload.hook_event_name !== 'Stop') return null;
    // 通知 hook 不请求续跑；续跑后的最终 Stop 也需通知。子 agent 单独过滤。
    if (payload.agent_id || payload.parentConversationId || payload.parent_conversation_id || (payload.nestingDepth !== undefined && payload.nestingDepth > 0) || (payload.nesting_depth !== undefined && payload.nesting_depth > 0) || payload.source === 'subagent') return null;
  } else {
    if (payload.hook_event_name && payload.hook_event_name !== 'Stop') return null;
    if (payload.agent_id || payload.source === 'subagent') return null;
  }
  const session = payload['thread-id'] ?? payload.session_id ?? payload.conversationId ?? payload.conversation_id ?? '';
  const turn = payload['turn-id'] ?? payload.turn_id ?? payload.prompt_id ?? (payload.executionNum !== undefined ? String(payload.executionNum) : '');
  const summary = payload['last-assistant-message'] ?? payload.last_assistant_message ?? payload.summary ?? '';
  const cwd = payload.cwd ?? (Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : '') ?? '';
  const sessionTitle = payload.session_title ?? payload['thread-name'] ?? payload.thread_name ?? '';
  const title = payload.title ?? '';
  const body = payload.body ?? payload.message ?? '';
  const message = payload.message ?? payload.body ?? '';
  const raw = payload.raw === true;
  const format = payload.format ?? '';

  for (const item of [session, turn, summary, cwd, sessionTitle, title, body, message, format]) {
    if (typeof item !== 'string') throw new Error('hook 的会话、轮次、正文、目录、标题字段必须是字符串');
  }
  if (!session && !turn && !summary && !title && !body && !message) throw new Error('hook 缺少事件身份或最终回复');
  // shortcut: 旧 Claude 未提供可读 transcript/轮次 ID 时，完全相同回复会去重；上游支持 prompt_id 后直接使用它。
  if (harness === 'claude' && !turn && !summary && !body && !message) throw new Error('Claude Stop 缺少 last_assistant_message');
  if (['agy', 'antigravity-cli'].includes(harness) && !turn && !summary && !body && !message) throw new Error('Antigravity Stop 缺少 last_assistant_message');

  const isAgentComplete = Boolean(payload.type === 'agent-turn-complete' || payload.hook_event_name === 'Stop' || (session && turn));
  const eventId = payload.eventId ?? payload.event_id ?? (
    title
      ? digest(JSON.stringify([harness, session, turn, turn ? '' : (summary || message || body), title]))
      : digest(JSON.stringify([harness, session, turn, turn ? '' : summary]))
  );

  return {
    harness,
    session,
    turn,
    summary,
    cwd,
    sessionTitle,
    title: title || undefined,
    body: body || undefined,
    message: message || undefined,
    raw,
    format: format || undefined,
    isTurnComplete: isAgentComplete,
    eventId
  };
}

async function* readRows(path) {
  let pending = '', oversized = false;
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    let start = 0, end;
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      if (!oversized) {
        let row;
        try { row = JSON.parse(pending + chunk.slice(start, end)); } catch { /* 跳过损坏记录 */ }
        if (object(row)) yield row;
      }
      pending = ''; oversized = false; start = end + 1;
    }
    if (!oversized) pending += chunk.slice(start);
    // 工具正文大记录无需解析标题；保留后续独立的标题元数据记录。
    if (pending.length > 1024 * 1024) { pending = ''; oversized = true; }
  }
  if (!oversized && pending) {
    let row;
    try { row = JSON.parse(pending); } catch { /* 跳过未写完的记录 */ }
    if (object(row)) yield row;
  }
}

export async function enrichCodex(payload, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  if (payload.session_title || payload['thread-name'] || payload.thread_name) return payload;
  const id = payload['thread-id'] ?? payload.session_id;
  if (typeof id !== 'string' || !id) return payload;
  let title;
  try {
    for await (const row of readRows(join(codexHome, 'session_index.jsonl'))) {
      if (row.id === id && typeof row.thread_name === 'string') title = row.thread_name;
    }
  } catch { /* 名称不可读时由格式化层标记未命名，不猜其他会话。 */ }
  return title ? { ...payload, session_title: title } : payload;
}

export async function enrichClaude(payload) {
  if (typeof payload.transcript_path !== 'string') return payload;
  const enriched = { ...payload };
  let customTitle, aiTitle;
  try {
    for await (const row of readRows(payload.transcript_path)) {
      if (row.sessionId && row.sessionId !== payload.session_id) continue;
      if (row.type === 'custom-title' && typeof row.customTitle === 'string') customTitle = row.customTitle;
      if (row.type === 'ai-title' && typeof row.aiTitle === 'string') aiTitle = row.aiTitle;
      const content = row.message?.content;
      if (!payload.turn_id && !payload.prompt_id && row.type === 'user' && typeof row.uuid === 'string' && (typeof content === 'string' || Array.isArray(content) && content.some(b => b.type === 'text'))) enriched.turn_id = row.uuid;
    }
  } catch { /* 不回显 transcript 路径或正文；无可读轮次 ID 则用摘要去重。 */ }
  enriched.session_title ||= customTitle || aiTitle;
  return enriched;
}

export async function enrichAgy(payload, { geminiHome = process.env.GEMINI_HOME ?? join(homedir(), '.gemini/antigravity-cli'), execFn = exec } = {}) {
  if (!object(payload)) return payload;
  const enriched = { ...payload };
  const session = enriched.conversationId ?? enriched.conversation_id ?? enriched.session_id;

  if (!enriched.session_title && session && typeof session === 'string') {
    try {
      const dbPath = join(geminiHome, 'conversation_summaries.db');
      const safeId = session.replaceAll("'", "''");
      const out = await execFn('sqlite3', ['-json', dbPath, `SELECT title, nesting_depth, parent_conversation_id FROM conversation_summaries WHERE conversation_id = '${safeId}' LIMIT 1`], { timeout: 3000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const rows = JSON.parse(out.stdout);
      if (Array.isArray(rows) && rows[0]) {
        if (rows[0].title && typeof rows[0].title === 'string') enriched.session_title = rows[0].title;
        if (rows[0].nesting_depth !== undefined) enriched.nesting_depth = rows[0].nesting_depth;
        if (rows[0].parent_conversation_id) enriched.parent_conversation_id = rows[0].parent_conversation_id;
      }
    } catch { /* DB 不可读时不阻断，保留未命名 */ }
  }

  const transcriptPath = enriched.transcriptPath ?? enriched.transcript_path;
  if (typeof transcriptPath === 'string' && transcriptPath) {
    let lastAssistantMessage = '';
    let lastUserIndex = '';
    let lastModelIndex = '';
    let needsFull = false;
    try {
      for await (const row of readRows(transcriptPath)) {
        const isModel = (row.type === 'PLANNER_RESPONSE' || row.role === 'model' || row.role === 'assistant') && row.type !== 'GENERIC';
        const isUser = row.source === 'USER_EXPLICIT' || row.type === 'USER_INPUT' || row.role === 'user';
        const content = row.content ?? row.text ?? row.message?.content ?? row.message?.text;
        if (isModel) {
          if (row.step_index !== undefined || row.stepIdx !== undefined) {
            lastModelIndex = String(row.step_index ?? row.stepIdx);
          }
          if (row.truncated_fields?.includes('content') || (!content && (row.type === 'PLANNER_RESPONSE' || row.status === 'DONE'))) {
            needsFull = true;
          } else if (typeof content === 'string' && content.trim()) {
            lastAssistantMessage = content;
            needsFull = false;
          }
        }
        if (isUser && (row.step_index !== undefined || row.stepIdx !== undefined)) {
          lastUserIndex = String(row.step_index ?? row.stepIdx);
        }
      }
    } catch { /* transcript 不可读时不阻断 */ }

    if (needsFull || !lastAssistantMessage) {
      try {
        const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl');
        for await (const row of readRows(fullPath)) {
          const isModel = (row.type === 'PLANNER_RESPONSE' || row.role === 'model' || row.role === 'assistant') && row.type !== 'GENERIC';
          const content = row.content ?? row.text ?? row.message?.content ?? row.message?.text;
          if (isModel && typeof content === 'string' && content.trim()) {
            lastAssistantMessage = content;
          }
        }
      } catch { /* transcript_full 不可读时不阻断 */ }
    }
    enriched.last_assistant_message ||= lastAssistantMessage;
    if (!enriched.turn_id && !enriched.prompt_id) {
      enriched.turn_id = lastUserIndex || lastModelIndex;
    }
  }
  return enriched;
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
  const HARNESS_NAMES = {
    codex: 'Codex',
    claude: 'Claude Code',
    dsh: 'DSH',
    agy: 'Antigravity',
    'antigravity-cli': 'Antigravity',
    kimi: 'Kimi Code',
    'kimi-code': 'Kimi Code',
    cline: 'Cline',
    zcode: 'ZCode',
    kiro: 'Kiro',
    kilo: 'Kilo',
    mailguard: 'mail-guard',
    'mail-guard': 'mail-guard'
  };
  const harnessName = HARNESS_NAMES[event.harness] ?? event.harness;

  // 1. 确定标题 title
  let title;
  if (event.title?.trim()) {
    title = event.title.trim();
  } else if (event.sessionTitle?.trim()) {
    title = `${harnessName} · ${event.sessionTitle.trim().replace(/\s+/gu, ' ')}`;
  } else if (event.isTurnComplete || (!event.message && !event.body && !event.raw)) {
    title = `${harnessName} · 未命名会话`;
  } else if (['codex', 'claude', 'dsh', 'agy', 'antigravity-cli'].includes(event.harness) && !event.raw) {
    title = `${harnessName} · 未命名会话`;
  } else {
    title = harnessName;
  }

  // 2. 提取摘要或正文
  const summary = event.message ?? event.body ?? (
    config.includeSummary
      ? (event.summary?.trim() || '未提供最终回复，请回到 harness 查看结果。')
      : '摘要未启用，请回到 harness 查看结果。'
  );

  // 3. 模版处理 (若配置中存在 templates)
  const template = config.templates?.[event.harness] ?? config.templates?.default ?? config.template;
  let body;
  if (template && typeof template === 'object') {
    const vars = {
      harness: event.harness,
      harnessName,
      title: event.title ?? title,
      sessionTitle: event.sessionTitle ?? '',
      cwd: event.cwd ?? '',
      summary,
      message: event.message ?? summary,
      body: event.body ?? summary
    };
    if (template.title) {
      title = template.title.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{${k}}`);
    }
    if (template.body) {
      body = template.body.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{${k}}`);
    }
  }

  // 4. 正文默认策略
  if (body === undefined) {
    if (event.body !== undefined) {
      body = short(event.body, 3000);
    } else if (event.raw === true) {
      body = short(summary, 3000);
    } else if (event.format === 'clean') {
      body = event.cwd ? `[${event.cwd}] ${short(summary, 1000)}` : short(summary, 1000);
    } else if (['mailguard', 'mail-guard'].includes(event.harness) && !event.cwd && !event.isTurnComplete) {
      body = short(summary, 3000);
    } else {
      body = `路径：${event.cwd || process.cwd()}\n完成摘要：${short(summary, 1000)}`;
    }
  }

  const text = short(body ? `${title}\n${body}` : title, 3800);
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
      } else if (channel.type === 'ntfy') {
        channel.server = serverURL(channel.server ?? 'https://ntfy.sh');
        if (new URL(channel.server).pathname !== '/') throw new Error('ntfy server 必须是根地址，topic 单独填写');
        channel.topic = required(channel.topic, 'topic');
        if (/[\s/\\]/u.test(channel.topic)) throw new Error('topic 不允许空白或路径分隔符');
        if (raw.token !== undefined) {
          channel.token = required(channel.token, 'token');
          if (/[\r\n]/u.test(channel.token)) throw new Error('token 不允许换行');
        }
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

async function post(url, body, timeoutMs, fetchFn, headers = {}) {
  let response;
  try {
    response = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
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
  if (c.type === 'ntfy') {
    const result = await post(`${c.server}/`, { topic: c.topic, title: p.title, message: shortUtf8(p.body, 4096) }, p.timeoutMs, fetchFn, c.token ? { Authorization: `Bearer ${c.token}` } : {});
    if (result.event !== 'message' || typeof result.id !== 'string' || !result.id || result.topic !== c.topic) throw new Error('ntfy 未返回目标 topic 的成功消息 ID');
    return { accepted: true, messageId: result.id };
  }
  const result = await runCLI(c.cli, ['im', '+messages-send', '--as', c.identity, c.userId ? '--user-id' : '--chat-id', String(c.userId ?? c.chatId), '--text', p.text, '--idempotency-key', digest(`${p.eventId}:${d.id}`).slice(0, 50), '--json'], p.timeoutMs, execFn);
  const messageId = result.data?.message_id ?? result.message_id;
  if (typeof messageId !== 'string' || !messageId.startsWith('om_')) throw new Error('飞书未返回消息 ID，发送结果未知');
  const readback = await runCLI(c.cli, ['im', '+messages-mget', '--as', c.identity, '--message-ids', messageId, '--no-reactions', '--json'], p.timeoutMs, execFn);
  const messages = readback.data?.messages ?? readback.messages ?? [];
  const message = messages.find(m => m.message_id === messageId);
  let text = message?.content;
  if (text === undefined) {
    try { text = JSON.parse(message?.body?.content ?? '{}').text; } catch { /* 下方统一验证 */ }
  }
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
