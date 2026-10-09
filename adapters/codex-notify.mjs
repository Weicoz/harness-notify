#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const [forwardPath, configPath, payload] = process.argv.slice(2);
try {
  const previous = JSON.parse(await readFile(forwardPath, 'utf8'));
  if (!Array.isArray(previous) || previous.some(item => typeof item !== 'string')) throw new Error();
  if (previous.length) {
    try { await exec(previous[0], [...previous.slice(1), payload], { timeout: 10000, maxBuffer: 1024 * 1024 }); }
    catch { console.error('harness-notify: 原 Codex 通知程序失败，继续任务推送'); }
  }
} catch { console.error('harness-notify: 原 Codex 通知配置无法读取'); }
try {
  const cli = fileURLToPath(new URL('../bin/harness-notify.mjs', import.meta.url));
  const result = await exec(process.execPath, [cli, 'hook', '--harness', 'codex', '--config', configPath, payload], { timeout: 100000, maxBuffer: 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
} catch { console.error('harness-notify: Codex 通知执行失败，未自动重试'); }
