import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullSummary, appliedSummary } from '../src/mobile-presentation.ts';
import type { PullPlan } from '../src/mobile/types.ts';

const plan: PullPlan = {
  id: 'review', head: 'a'.repeat(40), initial: false, changes: [], deletions: [],
  directories: ['00-收件箱', '20-商业观察', '30-商业调研'],
  summary: { remoteFiles: 13, managedFiles: 5, remoteDirectories: 10, excluded: [{ path: '.gitignore', reason: 'Git 配置' }, { path: '00-收件箱/.gitkeep', reason: '目录占位' }] },
};
test('summary distinguishes managed documents, excluded files and directories still to apply', () => {
  const text = pullSummary(plan);
  assert.match(text, /13 个文件/); assert.match(text, /10 个目录/);
  assert.match(text, /5 个文档或附件/); assert.match(text, /补齐 3 个目录/);
  assert.match(text, /排除 2/); assert.match(text, /尚未应用/);
});
test('completion summary distinguishes local-retained conflicts and applied remote updates', () => {
  const changed = { ...plan, changes: [{ path: 'note.md', kind: 'conflict' as const, deleted: false }, { path: 'other.md', kind: 'remote' as const, deleted: false }] };
  assert.match(appliedSummary(changed, { 'note.md': 'local' }), /下载或更新 1/);
  assert.match(appliedSummary(changed, { 'note.md': 'both' }), /下载或更新 2/);
  assert.match(appliedSummary(changed, {}), /目录 3/);
  assert.match(appliedSummary(changed, { 'note.md': 'both' }, ['note.md']), /下载或更新 1/);
  assert.match(appliedSummary(changed, {}, ['note.md']), /保留后续本地编辑 1/);
});
