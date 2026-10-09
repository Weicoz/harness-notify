import { mkdir, symlink, readlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../bin/harness-notify.mjs', import.meta.url));
const dir = join(homedir(), '.local/bin');
await mkdir(dir, { recursive: true });
await chmod(source, 0o755);
const target = join(dir, 'harness-notify');
try { await symlink(source, target); }
catch (e) {
  if (e.code !== 'EEXIST' || await readlink(target).catch(() => '') !== source) throw new Error('harness-notify 命令目标已存在，未覆盖');
}
console.log(`已安装：${target}\n请确保 ~/.local/bin 位于 PATH。`);
