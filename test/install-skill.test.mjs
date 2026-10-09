import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill } from '../scripts/install-skill.mjs';

test('技能安装 dry-run 无写入，维护源软链与重复幂等，不覆盖用户修改', async t => {
  const home = await mkdtemp(join(tmpdir(), 'harness-notify-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await installSkill({ home })).dryRun, true);
  assert.deepEqual(await readdir(home), []);
  const result = await installSkill({ home, apply: true });
  assert.equal(await readlink(result.entry), result.source);
  assert.equal(await readFile(join(result.source, 'SKILL.md'), 'utf8'), await readFile(new URL('../skills/weicoz-harness-notify/SKILL.md', import.meta.url), 'utf8'));
  assert.equal((await installSkill({ home, apply: true })).changed, false);
  await writeFile(join(result.source, 'SKILL.md'), '用户自定义内容');
  await assert.rejects(installSkill({ home, apply: true }), /未覆盖/);
  assert.equal(await readFile(join(result.source, 'SKILL.md'), 'utf8'), '用户自定义内容');
});
