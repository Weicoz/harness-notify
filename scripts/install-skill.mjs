import { readFile, mkdir, writeFile, symlink, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const files = ['SKILL.md', 'agents/openai.yaml'];
const name = 'weicoz-harness-notify';
async function optional(fn) {
  try { return await fn(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function installSkill({ apply = false, home = homedir() } = {}) {
  const source = join(home, '.skills-manager/skills', name);
  const entry = join(home, '.agents/skills', name);
  const content = [];
  for (const file of files) {
    const bytes = await readFile(new URL(`../skills/${name}/${file}`, import.meta.url));
    const existing = await optional(() => readFile(join(source, file)));
    if (existing !== null && !existing.equals(bytes)) throw new Error('本地技能与发布包不同，未覆盖；请先核对 diff');
    content.push({ file, bytes, missing: existing === null });
  }
  let link;
  try { link = await readlink(entry); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error('技能入口不是软链，未覆盖');
    link = null;
  }
  if (link !== null && link !== source) throw new Error('技能入口指向其他维护源，未覆盖');
  if (apply) {
    for (const item of content) if (item.missing) {
      await mkdir(join(source, item.file === 'SKILL.md' ? '' : 'agents'), { recursive: true });
      await writeFile(join(source, item.file), item.bytes, { flag: 'wx' });
    }
    await mkdir(join(home, '.agents/skills'), { recursive: true });
    if (link === null) await symlink(source, entry);
  }
  return { dryRun: !apply, source, entry, changed: content.some(item => item.missing) || link === null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--apply', '--dry-run'].includes(arg))) throw new Error('用法：node scripts/install-skill.mjs [--dry-run|--apply]');
    console.log(JSON.stringify(await installSkill({ apply: args.includes('--apply') && !args.includes('--dry-run') }), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
