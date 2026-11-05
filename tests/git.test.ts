import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository, allowedPath, safeEnvironment } from '../src/git.ts';

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reviewed-git-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test Author');
  git(root, 'config', 'user.email', 'author@example.invalid');
  git(root, 'config', 'core.quotePath', 'false');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/notes.git');
  await writeFile(join(root, 'first.md'), '# First\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial notes');
  return { root, repo: new Repository(root, 'example/notes') };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('upload policy', () => {
  it('allows documents and selected attachment types', () => {
    for (const path of ['感悟/想法.md', 'research/data.csv', 'images/a.png', 'research/report.pdf']) assert.equal(allowedPath(path), true);
  });
  it('rejects secrets, configuration, traversal and unsupported files', () => {
    for (const path of ['.obsidian/a.md', '.env', 'folder/.env.md', '.git/config', '../secret.md', '/secret.md', 'keys/private-key.md', 'credentials.md', 'token.txt', 'a.js', 'a.svg', '.github/workflows/run.yml']) assert.equal(allowedPath(path), false, path);
  });
  it('does not inherit tokens, Git overrides or shell injection settings', () => {
    const env = safeEnvironment({ HOME: '/home/test', GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret', GIT_DIR: '/other', GIT_SSH_COMMAND: 'bad', NODE_OPTIONS: 'bad', PATH: '/unsafe' });
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });
});

// Exercise real fetch/push against a local bare repository, without GitHub credentials.
class LocalRepository extends Repository {
  remote: string;
  offline = false;
  constructor(root: string, remote: string) { super(root, 'example/notes'); this.remote = remote; }
  protected override async transfer(args: string[]): Promise<Buffer> {
    if (this.offline) throw new Error('测试网络不可用');
    assert.equal(args.filter(arg => arg === this.url).length, 1);
    return Buffer.from(git(this.root, ...args.map(arg => arg === this.url ? this.remote : arg)));
  }
}

async function connected() {
  const { root } = await fixture();
  const remote = await mkdtemp(join(tmpdir(), 'reviewed-remote-')); roots.push(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  git(root, 'push', remote, 'main');
  return { root, remote, repo: new LocalRepository(root, remote) };
}

describe('reviewed synchronization with a real bare Git remote', () => {
  it('reviews outgoing commits and pushes the exact approved commit', async () => {
    const { root, remote, repo } = await connected();
    await writeFile(join(root, 'new.md'), 'new');
    await repo.commit(await repo.review(), ['new.md'], 'Reviewed note');
    const plan = await repo.reviewPush();
    assert.deepEqual(plan.commits.map(c => c.subject), ['Reviewed note']);
    assert.deepEqual(plan.commits[0]?.files, ['new.md']);
    await repo.push(plan);
    assert.equal(git(remote, 'rev-parse', 'main').trim(), plan.head);
    assert.equal((await repo.reviewPush()).commits.length, 0);
  });
  it('blocks a secret that was added and deleted in earlier unpushed commits', async () => {
    const { root, repo } = await connected();
    await writeFile(join(root, 'credentials.md'), 'private');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Added');
    git(root, 'rm', 'credentials.md'); git(root, 'commit', '-m', 'Removed');
    await assert.rejects(repo.reviewPush(), /历史包含不允许/);
  });
  it('blocks keys hidden in an earlier version of an allowed note', async () => {
    const { root, repo } = await connected();
    await writeFile(join(root, 'first.md'), '-----BEGIN PRIVATE KEY-----');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Added');
    await writeFile(join(root, 'first.md'), 'clean');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Removed');
    await assert.rejects(repo.reviewPush(), /私钥/);
  });
  it('rejects local commits created after push approval', async () => {
    const { root, repo } = await connected();
    const plan = await repo.reviewPush();
    git(root, 'commit', '--allow-empty', '-m', 'Other commit');
    await assert.rejects(repo.push(plan), /本地提交已变化/);
  });
  it('rejects a remote changed after push approval', async () => {
    const { root, remote, repo } = await connected();
    const plan = await repo.reviewPush();
    git(root, 'commit', '--allow-empty', '-m', 'Other commit');
    git(root, 'push', remote, 'main');
    git(root, 'reset', '--hard', plan.head);
    await assert.rejects(repo.push(plan), /远端已变化/);
  });
  it('fast-forwards a clean vault and refuses dirty worktrees', async () => {
    const { root, remote, repo } = await connected();
    const start = git(root, 'rev-parse', 'HEAD').trim();
    await writeFile(join(root, 'incoming.md'), 'incoming');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Incoming');
    git(root, 'push', remote, 'main');
    git(root, 'reset', '--hard', start);
    await repo.pull();
    assert.equal(await readFile(join(root, 'incoming.md'), 'utf8'), 'incoming');
    await repo.pull();
    await writeFile(join(root, 'first.md'), 'dirty');
    await assert.rejects(repo.pull(), /本地改动/);
  });
  it('rejects divergent history without resetting either side', async () => {
    const { root, remote, repo } = await connected();
    const start = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'commit', '--allow-empty', '-m', 'Remote');
    git(root, 'push', remote, 'main');
    git(root, 'reset', '--hard', start);
    git(root, 'commit', '--allow-empty', '-m', 'Local');
    const local = git(root, 'rev-parse', 'HEAD');
    await assert.rejects(repo.pull(), /分叉/);
    await assert.rejects(repo.reviewPush(), /分叉/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), local);
  });
  it('propagates transport failures and allows a later retry', async () => {
    const { repo } = await connected();
    repo.offline = true;
    await assert.rejects(repo.reviewPush(), /网络不可用/);
    repo.offline = false;
    assert.equal((await repo.reviewPush()).commits.length, 0);
  });
  it('blocks incoming symbolic links', async () => {
    const { root, remote, repo } = await connected();
    const start = git(root, 'rev-parse', 'HEAD').trim();
    await symlink('/etc/hosts', join(root, 'link.md'));
    git(root, 'add', '.'); git(root, 'commit', '-m', 'Link'); git(root, 'push', remote, 'main');
    git(root, 'reset', '--hard', start);
    await assert.rejects(repo.pull(), /链接/);
  });
});

describe('review and commit using real Git', () => {
  it('lists changes without staging and commits only selected files', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), '# Revised\n');
    await writeFile(join(root, '留待下次.md'), '# Later\n');
    const review = await repo.review();
    assert.equal(review.changes.length, 2);
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
    await repo.commit(review, ['first.md'], 'Selected update');
    assert.equal(git(root, 'show', '--format=', '--name-only', 'HEAD').trim(), 'first.md');
    assert.match(git(root, 'status', '--porcelain'), /留待下次/);
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  });
  it('handles Chinese, spaces, option-like names and shell characters literally', async () => {
    const { root, repo } = await fixture();
    const name = '-中文 $(touch injected) [x].md';
    await writeFile(join(root, name), '# Literal\n');
    const review = await repo.review();
    await repo.commit(review, [name], '-m $(touch message-injected)');
    assert.equal(git(root, 'show', 'HEAD:'+name), '# Literal\n');
    assert.equal(git(root, 'log', '-1', '--format=%s').trim(), '-m $(touch message-injected)');
  });
  it('rejects files edited after review', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'reviewed');
    const review = await repo.review();
    const before = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'first.md'), 'unreviewed');
    await assert.rejects(repo.commit(review, ['first.md'], 'Update'), /变化|重新/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  });
  it('rejects pre-staged files instead of mixing them into a commit', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'staged');
    git(root, 'add', '.');
    await assert.rejects(repo.review(), /暂存/);
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), 'first.md');
  });
  it('lists forbidden files but refuses their selection', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'credentials.md'), 'private');
    const review = await repo.review();
    assert.equal(review.changes[0]?.allowed, false);
    await assert.rejects(repo.commit(review, ['credentials.md'], 'No'), /允许|选择/);
  });
  it('rejects likely credentials in otherwise allowed documents', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), '-----BEGIN PRIVATE KEY-----\nprivate');
    const review = await repo.review();
    assert.equal(review.changes[0]?.allowed, false);
  });
  it('rejects a symlink pointing outside the vault', async () => {
    const { root, repo } = await fixture();
    await symlink('/etc/hosts', join(root, 'outside.md'));
    const review = await repo.review();
    assert.equal(review.changes[0]?.allowed, false);
    await assert.rejects(repo.commit(review, ['outside.md'], 'No'), /允许|选择/);
  });
  it('rejects files under a symlinked directory', async () => {
    const { root, repo } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'reviewed-outside-')); roots.push(outside);
    await writeFile(join(outside, 'note.md'), 'outside');
    await symlink(outside, join(root, 'linked'));
    await assert.rejects(repo.readDocument('linked/note.md'), /链接|目录|文库/);
  });
  it('records a selected deletion without deleting other local files', async () => {
    const { root, repo } = await fixture();
    await rm(join(root, 'first.md'));
    await writeFile(join(root, 'keep.md'), 'keep');
    const review = await repo.review();
    await repo.commit(review, ['first.md'], 'Remove first');
    assert.equal(git(root, 'ls-tree', '--name-only', 'HEAD').trim(), '');
    assert.equal(await readFile(join(root, 'keep.md'), 'utf8'), 'keep');
  });
  it('rejects another repository root or remote', async () => {
    const { root, repo } = await fixture();
    git(root, 'remote', 'set-url', 'origin', 'https://github.com/other/notes.git');
    await assert.rejects(repo.review(), /仓库|远端/);
    await mkdir(join(root, 'nested'));
    await assert.rejects(new Repository(join(root, 'nested'), 'other/notes').review(), /根目录|Git/);
  });
  it('refuses HTTP, credential-bearing URLs and URL rewrite rules', async () => {
    const { root, repo } = await fixture();
    git(root, 'remote', 'set-url', 'origin', 'https://user:password@github.com/example/notes.git');
    await assert.rejects(repo.review(), /远端|仓库/);
    git(root, 'remote', 'set-url', 'origin', 'https://github.com/example/notes.git');
    git(root, 'config', 'url.file:///tmp/.insteadOf', 'https://github.com/');
    await assert.rejects(repo.review(), /重写|远端/);
  });
  it('keeps existing Git hooks from executing', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, '.git/hooks/post-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 });
    await writeFile(join(root, 'first.md'), 'new');
    await repo.commit(await repo.review(), ['first.md'], 'Update');
    assert.doesNotMatch(git(root, 'status', '--porcelain'), /hook-ran/);
  });
  it('rejects repository-specific HTTP overrides', async () => {
    const { root, repo } = await fixture();
    git(root, 'config', 'http.https://github.com/example/notes.git.sslVerify', 'false');
    await assert.rejects(repo.review(), /HTTP|远端/);
  });
  it('rejects concurrent commits, stale HEAD and invalid selection', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'new');
    const review = await repo.review();
    await assert.rejects(repo.commit(review, [], 'Update'), /选择/);
    await assert.rejects(repo.commit(review, ['missing.md'], 'Update'), /选择/);
    await assert.rejects(repo.commit(review, ['first.md'], '  '), /说明/);
    git(root, 'commit', '--allow-empty', '-m', 'Other change');
    await assert.rejects(repo.commit(review, ['first.md'], 'Update'), /变化|重新/);
  });
  it('rejects in-progress merges before reviewing files', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, '.git/MERGE_HEAD'), git(root, 'rev-parse', 'HEAD'));
    await assert.rejects(repo.review(), /合并|进行中/);
  });
  it('rejects private keys in commit messages', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'new');
    await assert.rejects(repo.commit(await repo.review(), ['first.md'], '-----BEGIN PRIVATE KEY-----'), /提交说明.*私钥/);
  });
  it('does not overwrite another Git operation’s index lock', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'new');
    const review = await repo.review();
    await writeFile(join(root, '.git/index.lock'), 'owned by another operation');
    await assert.rejects(repo.commit(review, ['first.md'], 'Update'), /索引锁/);
    assert.equal(await readFile(join(root, '.git/index.lock'), 'utf8'), 'owned by another operation');
  });
  it('serializes commits and never mixes two selections', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'new');
    const review = await repo.review();
    const results = await Promise.allSettled([repo.commit(review, ['first.md'], 'One'), repo.commit(review, ['first.md'], 'Two')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(git(root, 'rev-list', '--count', 'HEAD').trim(), '2');
  });
  it('rejects empty and secret-bearing repository bindings', () => {
    for (const repository of ['', 'owner/repo.git', 'https://github.com/owner/repo', 'user:password/repo', '../repo']) {
      assert.throws(() => new Repository('/tmp', repository), /owner\/repository/);
    }
  });
  it('shows a text preview and blocks oversized files', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), '# Updated\n');
    const review = await repo.review();
    assert.match(await repo.preview(review, 'first.md'), /Updated/);
    await writeFile(join(root, 'large.md'), Buffer.alloc(21*1024*1024));
    const second = await repo.review();
    assert.equal(second.changes.find(c => c.path === 'large.md')?.allowed, false);
  });
});
