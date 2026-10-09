import { readFile, mkdir, writeFile, rename, stat, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const suffix = () => `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function addStop(raw, command) {
  const data = raw === null ? {} : JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('已有 hook 配置不是 JSON 对象');
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks))) throw new Error('已有 hooks 结构不合法');
  data.hooks ??= {};
  data.hooks.Stop ??= [];
  if (!Array.isArray(data.hooks.Stop)) throw new Error('已有 Stop 结构不合法');
  if (data.hooks.Stop.some(group => group.hooks?.some(h => h.command === command))) return raw;
  data.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 100 }] });
  return JSON.stringify(data, null, 2) + '\n';
}

export function replaceNotify(raw, next) {
  const text = raw ?? '';
  const match = /^notify\s*=\s*\[/m.exec(text);
  if (!match) return { previous: [], after: `notify = ${JSON.stringify(next)}\n${text}` };
  const section = /^\s*\[[A-Za-z"']/m.exec(text);
  if (section && section.index < match.index) throw new Error('只支持根层 notify，未修改 Codex 配置');
  const start = match.index + match[0].lastIndexOf('[');
  let quoted = false, escaped = false, end = start;
  for (; end < text.length; end++) {
    const char = text[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ']') break;
  }
  let previous;
  // 仅改可确定边界的双引号字符串数组；复杂 TOML 留给手工接入，禁止猜改。
  try { previous = JSON.parse(text.slice(start, end + 1).replace(/,\s*\]$/, ']')); }
  catch { throw new Error('现有 notify 使用复杂 TOML，请按 README 手工串联；未修改'); }
  if (!Array.isArray(previous) || previous.some(v => typeof v !== 'string')) throw new Error('notify 必须是命令字符串数组');
  return { previous, after: text.slice(0, match.index) + `notify = ${JSON.stringify(next)}` + text.slice(end + 1) };
}

export async function installHooks({ apply = false, cliPath, configPath, home = homedir(), nodePath = process.execPath }) {
  const changes = [];
  const codexPath = join(home, '.codex/config.toml');
  const codexBefore = await readOptional(codexPath);
  const forwardPath = join(home, '.config/harness-notify/codex-forward.json');
  const adapter = fileURLToPath(new URL('../adapters/codex-notify.mjs', import.meta.url));
  const notifyArgs = [nodePath, adapter, forwardPath, configPath];
  const codex = replaceNotify(codexBefore, notifyArgs);
  const forwardBefore = await readOptional(forwardPath);
  const wrapped = JSON.stringify(codex.previous) === JSON.stringify(notifyArgs);
  if (wrapped && forwardBefore === null) throw new Error('Codex 已串联但原通知配置缺失，未覆盖');
  if (!wrapped && forwardBefore !== null) throw new Error('已有 Codex 转发配置，未覆盖；请检查本地文件');
  if (codex.previous.includes(adapter) && !wrapped) throw new Error('已有不同的 Codex 通知串联，未覆盖');
  changes.push({ harness: 'codex-forward', path: forwardPath, before: forwardBefore, after: wrapped ? forwardBefore : JSON.stringify(codex.previous, null, 2) + '\n' });
  changes.push({ harness: 'codex', path: codexPath, before: codexBefore, after: codex.after });
  for (const [harness, path] of [['claude', join(home, '.claude/settings.json')]]) {
    const command = `${quote(nodePath)} ${quote(cliPath)} hook --harness ${harness} --config ${quote(configPath)}`;
    const before = await readOptional(path);
    changes.push({ harness, path, before, after: addStop(before, command) });
  }
  const path = join(home, '.dsh/cordis.patch.yml');
  const before = await readOptional(path);
  const marker = '# harness-notify:begin';
  const plugin = fileURLToPath(new URL('../adapters/dsh.mjs', import.meta.url));
  const block = `${marker}\n- insert:\n    - id: harness-notify\n      name: ${JSON.stringify(plugin)}\n      config:\n        configPath: ${JSON.stringify(configPath)}\n# harness-notify:end\n`;
  // YAML 不重序列化，原配置逐字保留；已有同名非托管节点不擅自覆盖。
  if (before?.includes(marker) && !before.includes(block)) throw new Error('DSH 已有不同的 harness-notify 配置，未覆盖');
  if (!before?.includes(marker) && /\bid:\s*["']?harness-notify\b/.test(before ?? '')) throw new Error('DSH 已有同名插件节点，未覆盖');
  changes.push({ harness: 'dsh', path, before, after: before?.includes(marker) ? before : (before ?? '') + (before && !before.endsWith('\n') ? '\n' : '') + '\n' + block });
  const result = [];
  for (const change of changes) {
    const changed = change.before !== change.after;
    let backup;
    if (apply && changed) {
      // 防止盘点到写入之间覆盖其他进程的新配置。
      if (await readOptional(change.path) !== change.before) throw new Error('hook 配置被其他进程修改，请重新预演');
      await mkdir(dirname(change.path), { recursive: true, mode: 0o700 });
      let mode = 0o600;
      if (change.before !== null) {
        mode = (await stat(change.path)).mode & 0o777;
        backup = `${change.path}.harness-notify-backup-${suffix()}`;
        await copyFile(change.path, backup);
      }
      const temp = `${change.path}.harness-notify-tmp-${suffix()}`;
      await writeFile(temp, change.after, { mode, flag: 'wx' });
      await rename(temp, change.path);
    }
    result.push({ harness: change.harness, path: change.path, changed, ...(backup ? { backup } : {}) });
  }
  return { dryRun: !apply, changes: result };
}
