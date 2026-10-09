import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'harness-notify';
export const inject = ['sessions'];

export function payloadFor(session, event) {
  if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'completed' || session.header.origin === 'subagent') return null;
  const events = session.snapshotEvents();
  const last = events.findLast(e => e.type === 'assistant/message' && e.data.turn === event.data.turn);
  const content = last?.data?.message?.content;
  const summary = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
  const title = events.findLast(e => e.type === 'session/title')?.data?.title ?? '';
  return { type: 'agent-turn-complete', session_id: session.header.id, turn_id: String(event.data.turn), cwd: session.header.cwd ?? '', session_title: title, last_assistant_message: summary };
}

export function apply(ctx, config = {}) {
  const cli = fileURLToPath(new URL('../bin/harness-notify.mjs', import.meta.url));
  const children = new Set();
  ctx.on('dispose', () => { for (const child of children) child.kill('SIGTERM'); });
  ctx.on('session/event', (session, event) => {
    const payload = payloadFor(session, event);
    if (!payload) return;
    // 子进程异步推送，不延迟或阻断已提交的任务结束事件。
    const child = spawn(process.execPath, [cli, 'hook', '--harness', 'dsh', ...(config.configPath ? ['--config', config.configPath] : [])], { stdio: ['pipe', 'ignore', 'pipe'] });
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGTERM'), 100000);
    let error = '';
    child.stderr.on('data', chunk => { if (error.length < 2000) error += chunk.toString().slice(0, 2000 - error.length); });
    child.on('error', () => { clearTimeout(timer); ctx.logger('harness-notify').warn('通知进程启动失败'); });
    child.on('close', () => { children.delete(child); clearTimeout(timer); if (error) ctx.logger('harness-notify').warn(error.trim()); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    return new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
  });
}
