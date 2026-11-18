import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository, allowedPath, safeEnvironment } from '../src/git.ts';
import { NativeSync, type NativePort } from '../src/native-sync.ts';

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
  afterPush?: () => void;
  constructor(root: string, remote: string) { super(root, 'example/notes'); this.remote = remote; }
  protected override async transfer(args: string[]): Promise<Buffer> {
    if (this.offline) throw new Error('测试网络不可用');
    assert.equal(args.filter(arg => arg === this.url).length, 1);
    const result = Buffer.from(git(this.root, ...args.map(arg => arg === this.url ? this.remote : arg)));
    if (args[0] === 'push') this.afterPush?.();
    return result;
  }
}

async function connected() {
  const { root } = await fixture();
  const remote = await mkdtemp(join(tmpdir(), 'reviewed-remote-')); roots.push(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  git(root, 'push', remote, 'main');
  return { root, remote, repo: new LocalRepository(root, remote) };
}
function port(repo:LocalRepository):NativePort{
  const inner=repo as unknown as {run:NativePort['run'];guard:NativePort['guard'];indexDigest:NativePort['indexDigest'];indexDocument:NativePort['indexRead']};
  return {root:repo.root,repository:repo.repository,url:repo.url,run:(...args)=>inner.run(...args),transfer:args=>repo['transfer'](args),guard:()=>inner.guard(),indexDigest:()=>inner.indexDigest(),read:(path,raw)=>repo.readDocument(path,raw),indexRead:path=>inner.indexDocument(path)};
}

describe('reviewed synchronization with a real bare Git remote', () => {
  it('enforces the snapshot budget even when every worktree file already matches the remote',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();const body=Buffer.alloc(9*1024*1024,66);
    for(let i=0;i<3;i++)await writeFile(join(root,`large-${i}.md`),body);
    git(root,'add','.');git(root,'commit','-m','Large remote');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    for(let i=0;i<3;i++)await writeFile(join(root,`large-${i}.md`),body);
    await assert.rejects(repo.planPull(),/50 MiB/);assert.equal(git(root,'rev-parse','HEAD').trim(),base);
  });
  it('replaces and cancels attach previews without retaining their temporary Git directories',async()=>{
    const {remote}=await connected();const root=await mkdtemp(join(tmpdir(),'wudao-preview-'));roots.push(root);const repo=new LocalRepository(root,remote);
    const adapter=port(repo);const run=adapter.run;const created:string[]=[];
    adapter.run=async(...args)=>{if(args[0][0]==='init'&&args[0][1]==='--bare')created.push(args[0][2]!);return run(...args);};
    const engine=new NativeSync(adapter);const first=await engine.planAttach();const next=await engine.planAttach();
    await assert.rejects(readFile(join(created[0]!,'HEAD')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
    await assert.rejects(engine.applyPull(first),/失效/);await engine.discard(next.id);
    await assert.rejects(readFile(join(created[1]!,'HEAD')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
  });
  it('rejects index changes arriving after a merge preview without losing the new staged content',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'first.md'),'remote');git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    const adapter=port(repo);const run=adapter.run;let injected=false;
    adapter.run=async(...args)=>{const result=await run(...args);if(args[0][0]==='write-tree'&&!injected){injected=true;await writeFile(join(root,'first.md'),'late staged');git(root,'add','first.md');}return result;};
    const engine=new NativeSync(adapter);const plan=await engine.planPull();await assert.rejects(engine.applyPull(plan),/暂存区.*变化/);
    assert.equal(git(root,'show',':first.md'),'late staged');assert.equal(git(root,'rev-parse','HEAD').trim(),base);
  });
  it('recovers a partial write while retaining later bytes and an original worktree backup',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'first.md'),'remote');git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    await writeFile(join(root,'first.md'),'unsaved local original');
    const adapter=port(repo);const read=adapter.read;let reads=0;
    adapter.read=async(path,raw)=>{if(raw&&path==='first.md'&&++reads===2){await writeFile(join(root,path),'partial');throw new Error('write interrupted');}return read(path,raw);};
    const engine=new NativeSync(adapter);const plan=await engine.planPull();await assert.rejects(engine.applyPull(plan,{'first.md':'remote'}),/interrupted/);
    assert.equal(await engine.recovery(),true);const result=await repo.recover();assert.deepEqual(result.preserved,['first.md']);
    assert.equal(await readFile(join(root,'first.md'),'utf8'),'partial');assert.equal(await readFile(join(root,'first.recovery-copy.md'),'utf8'),'unsaved local original');assert.equal(await repo.recovery(),false);
  });
  it('applies a remote update while retaining unrelated worktree edits and staged bytes', async () => {
    const {root,remote,repo}=await connected();const start=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'incoming.md'),'remote');git(root,'add','incoming.md');git(root,'commit','-m','Incoming');git(root,'push',remote,'main');git(root,'reset','--hard',start);
    await writeFile(join(root,'first.md'),'staged local');git(root,'add','first.md');await writeFile(join(root,'first.md'),'later local');
    const plan=await repo.planPull();assert.equal(plan.changes[0]?.path,'incoming.md');await repo.applyPull(plan);
    assert.equal(await readFile(join(root,'incoming.md'),'utf8'),'remote');assert.equal(await readFile(join(root,'first.md'),'utf8'),'later local');assert.equal(git(root,'show',':first.md'),'staged local');
  });
  it('merges divergent histories using two real parents and can push the reviewed merge',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'remote.md'),'remote');git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');const incoming=git(root,'rev-parse','HEAD').trim();git(root,'reset','--hard',base);
    await writeFile(join(root,'local.md'),'local');git(root,'add','.');git(root,'commit','-m','Local');const local=git(root,'rev-parse','HEAD').trim();
    await repo.applyPull(await repo.planPull());assert.equal(git(root,'show','HEAD:local.md'),'local');assert.equal(git(root,'show','HEAD:remote.md'),'remote');
    assert.deepEqual(git(root,'rev-list','--parents','-n','1','HEAD').trim().split(' ').slice(1),[local,incoming]);
    assert.deepEqual(await repo.historyFiles(git(root,'rev-parse','HEAD').trim()),[{path:'remote.md',status:'A'}]);
    await repo.push(await repo.reviewPush());assert.equal(git(remote,'rev-parse','main'),git(root,'rev-parse','HEAD'));
  });
  it('advances the Git baseline when the worktree already equals a remote update or deletion',async()=>{
    for(const deleted of [false,true]){
      const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
      if(deleted)git(root,'rm','first.md');else await writeFile(join(root,'first.md'),'remote');
      git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');const target=git(root,'rev-parse','HEAD').trim();git(root,'reset','--hard',base);
      if(deleted)await rm(join(root,'first.md'));else await writeFile(join(root,'first.md'),'remote');
      const plan=await repo.planPull();await repo.applyPull(plan);assert.equal(git(root,'rev-parse','HEAD').trim(),target);assert.equal(git(root,'status','--porcelain'),'');
    }
  });
  it('stops excluded remote changes instead of creating a merge that silently discards them',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'unsupported.docx'),'document');git(root,'add','.');git(root,'commit','-m','Unsupported');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    await assert.rejects(repo.planPull(),/排除文件/);assert.equal(git(root,'rev-parse','HEAD').trim(),base);assert.equal(git(root,'status','--porcelain'),'');
  });
  it('preserves remote Git placeholder metadata and independent staged and worktree conflict copies',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await mkdir(join(root,'empty'));await writeFile(join(root,'empty/.gitkeep'),'');await writeFile(join(root,'first.md'),'remote');git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    await writeFile(join(root,'first.md'),'unique staged');git(root,'add','first.md');await writeFile(join(root,'first.md'),'unique worktree');
    await repo.applyPull(await repo.planPull(),{'first.md':'both'});
    assert.equal(await readFile(join(root,'first.local-copy.md'),'utf8'),'unique worktree');assert.equal(await readFile(join(root,'first.staged-copy.md'),'utf8'),'unique staged');
    assert.equal(git(root,'show','HEAD:empty/.gitkeep'),'');assert.equal(await readFile(join(root,'empty/.gitkeep'),'utf8'),'');
  });
  it('requires a conflict choice before modifying a path with a distinct staged version',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'first.md'),'remote');git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    await writeFile(join(root,'first.md'),'staged');git(root,'add','first.md');await writeFile(join(root,'first.md'),'remote');
    const plan=await repo.planPull();assert.equal(plan.changes[0]?.kind,'conflict');assert.match(await repo.previewPull(plan,'first.md'),/staged/);
    await repo.applyPull(plan,{'first.md':'local'});assert.equal(git(root,'show',':first.md'),'staged');assert.equal(await readFile(join(root,'first.md'),'utf8'),'remote');
  });
  it('requires conflict choices and keeps a local copy when applying both versions',async()=>{
    const {root,remote,repo}=await connected();const base=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'first.md'),'remote');git(root,'add','.');git(root,'commit','-m','Remote');git(root,'push',remote,'main');git(root,'reset','--hard',base);
    await writeFile(join(root,'first.md'),'local');git(root,'add','.');git(root,'commit','-m','Local');
    const plan=await repo.planPull();assert.equal(plan.changes[0]?.kind,'conflict');await assert.rejects(repo.applyPull(plan),/冲突/);
    await repo.applyPull(plan,{'first.md':'both'});assert.equal(await readFile(join(root,'first.md'),'utf8'),'remote');assert.equal(await readFile(join(root,'first.local-copy.md'),'utf8'),'local');
  });
  it('attaches an existing nonempty directory without deleting local-only notes',async()=>{
    const {remote}=await connected();const root=await mkdtemp(join(tmpdir(),'wudao-existing-'));roots.push(root);
    await writeFile(join(root,'first.md'),'my original');await writeFile(join(root,'local.md'),'local only');const repo=new LocalRepository(root,remote);
    const plan=await repo.planAttach();assert.equal(plan.initial,true);assert.equal(await repo.initialized(),false);
    await repo.applyPull(plan,{'first.md':'local'});assert.equal(await repo.initialized(),true);
    assert.equal(await readFile(join(root,'first.md'),'utf8'),'my original');assert.equal(await readFile(join(root,'local.md'),'utf8'),'local only');
    assert.equal((await repo.review()).changes.length,2);assert.equal(git(remote,'rev-list','--count','main').trim(),'1');
  });
  it('reviews outgoing commits and pushes the exact approved commit', async () => {
    const { root, remote, repo } = await connected();
    await writeFile(join(root, 'new.md'), 'new');
    await repo.commit(await repo.review(), ['new.md'], 'Reviewed note');
    const plan = await repo.reviewPush();
    assert.deepEqual(plan.commits.map(c => c.subject), ['Reviewed note']);
    assert.deepEqual(plan.commits[0]?.files, ['new.md']);
    const result = await repo.push(plan);
    assert.equal(result.trackingUpdated, true);
    assert.equal(git(remote, 'rev-parse', 'main').trim(), plan.head);
    assert.equal(git(root, 'rev-parse', 'origin/main').trim(), plan.head);
    assert.equal(git(root, 'rev-parse', 'refs/remotes/wudao-git/main').trim(), plan.head);
    assert.equal((await repo.reviewPush()).commits.length, 0);
  });
  it('preserves a newer local tracking reference while reporting the successful remote upload', async () => {
    const { root, remote, repo } = await connected();
    await writeFile(join(root, 'new.md'), 'new');
    await repo.commit(await repo.review(), ['new.md'], 'Reviewed note');
    const plan = await repo.reviewPush();
    const ahead = git(root, 'commit-tree', git(root, 'rev-parse', 'HEAD^{tree}').trim(), '-p', plan.head, '-m', 'Newer snapshot').trim();
    git(root, 'update-ref', 'refs/remotes/origin/main', ahead);
    const result = await repo.push(plan);
    assert.equal(result.trackingUpdated, false);
    assert.equal(git(remote, 'rev-parse', 'main').trim(), plan.head);
    assert.equal(git(root, 'rev-parse', 'origin/main').trim(), ahead);
  });
  it('reports an acknowledged push when the local tracking cache cannot be read safely', async () => {
    const { root, remote, repo } = await connected();
    await writeFile(join(root, 'new.md'), 'new');
    await repo.commit(await repo.review(), ['new.md'], 'Reviewed note');
    const plan = await repo.reviewPush();
    // A missing object simulates a cache failure after the server acknowledged the push.
    repo.afterPush = () => { writeFileSync(join(root, '.git/refs/remotes/origin/main'), 'f'.repeat(40)+'\n'); };
    const result = await repo.push(plan);
    assert.equal(result.trackingUpdated, false);
    assert.equal(git(remote, 'rev-parse', 'main').trim(), plan.head);
    assert.equal(result.commit, plan.head);
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
  it('compares worktree against the staged index and staged changes against HEAD',async()=>{
    const {root,repo}=await fixture();await writeFile(join(root,'first.md'),'B');git(root,'add','first.md');await writeFile(join(root,'first.md'),'C');
    assert.match(await repo.preview(await repo.review(),'first.md'),/变更前\nB\n\n变更后\nC/);
    assert.match(await repo.preview(await repo.reviewStaged(),'first.md'),/变更前\n# First\n\n\n变更后\nB/);
  });
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
  it('preserves existing staging and commits its reviewed snapshot even after later edits', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'staged');
    git(root, 'add', '.');
    const review = await repo.reviewStaged();
    await writeFile(join(root, 'first.md'), 'later work');
    await repo.commit(review, ['first.md'], 'Staged snapshot');
    assert.equal(git(root, 'show', 'HEAD:first.md'), 'staged');
    assert.equal(await readFile(join(root, 'first.md'), 'utf8'), 'later work');
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  });
  it('commits selected worktree files without losing another staged file', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'first.md'), 'staged'); git(root, 'add', 'first.md');
    await writeFile(join(root, 'other.md'), 'selected');
    await repo.commit(await repo.review(), ['other.md'], 'Only other');
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), 'first.md');
    assert.equal(git(root, 'show', ':first.md'), 'staged');
    assert.equal(git(root, 'show', 'HEAD:first.md'), '# First\n');
  });
  it('stages and unstages a reviewed file without changing its working content', async () => {
    const { root, repo } = await fixture(); await writeFile(join(root, 'first.md'), 'snapshot');
    await repo.stage(await repo.review(), ['first.md']);
    assert.equal(git(root, 'show', ':first.md'), 'snapshot');
    await repo.unstage(['first.md']);
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
    assert.equal(await readFile(join(root, 'first.md'), 'utf8'), 'snapshot');
  });
  it('reads real history and file differences without changing the repository', async () => {
    const { root, repo } = await fixture(); const head = git(root, 'rev-parse', 'HEAD').trim();
    const history = await repo.history(); assert.equal(history[0]?.hash, head);
    assert.deepEqual(await repo.historyFiles(head), [{ path: 'first.md', status: 'A' }]);
    assert.match(await repo.historyPreview(head, 'first.md'), /First/);
    assert.equal(git(root, 'status', '--porcelain'), '');
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
