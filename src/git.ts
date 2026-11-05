import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const MAX_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.md', '.txt', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;

export function allowedPath(path: string): boolean {
  const parts = path.split('/');
  return path.length > 0 && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path)
    && parts.every(part => part.length > 0 && part !== '..' && !part.startsWith('.')
      && !/(?:^|[-_.])(?:secrets?|credentials?|tokens?|passwords?|private[-_]?keys?)(?:[-_.]|$)/i.test(part)
      && !['keys', 'ssh'].includes(part.toLowerCase()))
    && EXTENSIONS.has(extname(path).toLowerCase());
}

export function safeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    HOME: source.HOME || homedir(),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LITERAL_PATHSPECS: '1',
  };
}

export interface Change {
  path: string;
  status: string;
  allowed: boolean;
  reason: string;
  digest: string;
}

export interface Review {
  head: string;
  branch: string;
  changes: Change[];
}

export interface OutgoingCommit { hash: string; subject: string; files: string[] }
export interface PushReview { head: string; branch: string; remoteHead: string; commits: OutgoingCommit[] }

class GitError extends Error {
  code: number;
  constructor(code: number) {
    super(`Git 操作失败（${code}）。请检查仓库、钥匙串凭据或网络；本地提交会保留。`);
    this.code = code;
  }
}

export class Repository {
  readonly root: string;
  readonly repository: string;
  readonly url: string;
  private busy = false;

  constructor(root: string, repository: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) || repository.endsWith('.git')) {
      throw new Error('请设置 GitHub 仓库，格式为 owner/repository，省略 .git。');
    }
    this.root = resolve(root);
    this.repository = repository;
    this.url = `https://github.com/${repository}.git`;
  }

  private async run(args: string[], input?: Buffer | string, index?: string): Promise<Buffer> {
    return new Promise((accept, reject) => {
      const child = execFile('/usr/bin/git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.askPass=',
        '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
        '-c', 'credential.helper=', '-c', 'credential.helper=osxkeychain',
        '-c', 'credential.useHttpPath=true', '-c', 'credential.interactive=false',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-c', 'http.sslVerify=true', '-c', 'http.followRedirects=false',
        ...args,
      ], {
        cwd: this.root, shell: false, encoding: 'buffer', timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...safeEnvironment(), ...(index ? { GIT_INDEX_FILE: index } : {}) },
      }, (error, stdout) => {
        if (error) { reject(new GitError(typeof error.code === 'number' ? error.code : -1)); return; }
        accept(stdout);
      });
      child.stdin?.on('error', () => { /* The process callback reports failure. */ });
      child.stdin?.end(input);
    });
  }

  private async text(args: string[]): Promise<string> { return (await this.run(args)).toString('utf8').trim(); }

  private async optional(args: string[]): Promise<string> {
    try { return await this.text(args); }
    catch (error) { if (error instanceof GitError && error.code === 1) return ''; throw error; }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('已有 Git 操作正在进行，请等待完成。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }

  private async guard(): Promise<{ head: string; branch: string; directory: string }> {
    const directory = join(this.root, '.git');
    let metadata;
    try { metadata = await lstat(directory); }
    catch { throw new Error('请先在文库根目录初始化 Git 仓库并创建首次提交。'); }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('仅支持文库根目录中的普通 Git 仓库。');
    for (const name of ['config', 'objects', 'refs']) {
      if ((await lstat(join(directory, name))).isSymbolicLink()) throw new Error('Git 元数据包含符号链接，请使用普通 Git 仓库。');
    }
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'BISECT_LOG']) {
      try { await lstat(join(directory, marker)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Error('仓库有合并、变基或其他进行中的 Git 操作，请先在外部 Git 中完成。');
    }
    if (await realpath(this.root) !== await realpath(await this.text(['rev-parse', '--show-toplevel']))) throw new Error('Git 根目录必须与文库根目录一致。');
    const unsafe = await this.optional(['config', '--local', '--includes', '--name-only', '--get-regexp', '^(url\.|filter\.|http\.)']);
    if (unsafe) throw new Error('仓库包含 URL 重写、HTTP 覆盖或文件过滤器配置，请使用外部 Git 检查。');
    for (const mode of ['--fetch', '--push']) {
      const args = mode === '--push' ? ['remote', 'get-url', '--push', '--all', 'origin'] : ['remote', 'get-url', '--all', 'origin'];
      if ((await this.text(args)).toLowerCase() !== this.url.toLowerCase()) throw new Error('origin 远端与已绑定的 GitHub 仓库不一致。');
    }
    if (await this.text(['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('请先使用完整 Git 历史记录，浅克隆暂不支持。');
    const ref = await this.text(['symbolic-ref', '--quiet', 'HEAD']);
    if (!ref.startsWith('refs/heads/')) throw new Error('请先切换到本地分支。');
    const branch = ref.slice('refs/heads/'.length);
    const head = await this.text(['rev-parse', '--verify', 'HEAD']);
    return { head, branch, directory };
  }

  private async changes(): Promise<{ path: string; status: string }[]> {
    const raw = (await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).toString('utf8');
    const result = raw.split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
    if (result.some(entry => entry.status.includes('U') || ['AA', 'DD'].includes(entry.status))) throw new Error('仓库存在冲突，请先使用外部 Git 解决。');
    if (result.some(entry => entry.status !== '??' && entry.status[0] !== ' ')) throw new Error('发现已暂存的内容，请先使用外部 Git 处理，避免混入本次提交。');
    return result;
  }

  async readDocument(path: string): Promise<Buffer | null> {
    if (!allowedPath(path)) throw new Error('此文件不在允许上传的文档范围内。');
    const parts = path.split('/');
    let current = this.root;
    for (const [i, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error('文件路径包含链接或非目录节点，无法读取文库外部文件。');
      if (i === parts.length - 1 && (!stat.isFile() || stat.size > MAX_BYTES)) throw new Error('仅允许不超过 20 MiB 的普通文件。');
    }
    const parent = await realpath(join(current, '..'));
    const root = await realpath(this.root);
    if (parent !== root && !parent.startsWith(root + '/')) throw new Error('文件位于文库外部。');
    const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_BYTES) throw new Error('文件过大或不是普通文件。');
      const bytes = await file.readFile();
      const after = await file.stat();
      if (bytes.length > MAX_BYTES || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('文件读取期间发生变化，请重新检查。');
      if (SECRET.test(bytes.toString('utf8'))) throw new Error('文件中发现疑似令牌或私钥，请移除后重新检查。');
      return bytes;
    } finally { await file.close(); }
  }

  private digest(bytes: Buffer | null): string { return bytes === null ? 'deleted' : createHash('sha256').update(bytes).digest('hex'); }

  async review(): Promise<Review> {
    if (this.busy) throw new Error('已有 Git 操作正在进行。');
    const state = await this.guard();
    const changes: Change[] = [];
    for (const item of await this.changes()) {
      if (!allowedPath(item.path)) { changes.push({ ...item, allowed: false, reason: '文件类型或路径不在允许范围内', digest: '' }); continue; }
      try {
        const bytes = await this.readDocument(item.path);
        changes.push({ ...item, allowed: true, reason: '', digest: this.digest(bytes) });
      } catch (error) {
        changes.push({ ...item, allowed: false, reason: error instanceof Error ? error.message : '文件无法安全读取', digest: '' });
      }
    }
    return { head: state.head, branch: state.branch, changes };
  }

  async preview(review: Review, path: string): Promise<string> {
    const change = review.changes.find(item => item.path === path && item.allowed);
    if (!change) throw new Error('请选择允许查看的文件。');
    const bytes = await this.readDocument(path);
    if (this.digest(bytes) !== change.digest) throw new Error('文件已变化，请重新检查。');
    if (bytes && (bytes.includes(0) || !['.md', '.txt', '.csv'].includes(extname(path).toLowerCase()))) return '附件仅展示文件名；请在 Obsidian 中打开附件检查内容后再选择提交。';
    const exists = (await this.run(['ls-tree', '-z', review.head, '--', path])).length > 0;
    const before = exists ? (await this.run(['cat-file', 'blob', `${review.head}:${path}`])).toString('utf8') : '（新文件）';
    return `变更前\n${before.slice(0, 50_000)}\n\n变更后\n${bytes?.toString('utf8').slice(0, 50_000) ?? '（删除文件）'}\n\n（每部分最多显示 50,000 个字符）`;
  }

  async commit(review: Review, selected: string[], message: string): Promise<string> {
    return this.exclusive(async () => {
      if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择需要提交的文件。');
      if (!message.trim() || message.length > 1000 || message.includes('\0')) throw new Error('提交说明不能为空，且最多 1000 个字符。');
      if (SECRET.test(message)) throw new Error('提交说明包含疑似令牌或私钥，请移除后重新检查。');
      const state = await this.guard();
      if (state.head !== review.head || state.branch !== review.branch) throw new Error('分支或提交已变化，请重新检查。');
      await this.changes();
      const documents = [];
      let totalBytes = 0;
      for (const path of selected) {
        const change = review.changes.find(item => item.path === path && item.allowed);
        if (!change) throw new Error('选择包含未审阅或不允许上传的文件。');
        const bytes = await this.readDocument(path);
        if (this.digest(bytes) !== change.digest) throw new Error('文件已发生变化，请重新检查后提交。');
        totalBytes += bytes?.length ?? 0;
        if (totalBytes > 50 * 1024 * 1024) throw new Error('本次选择超过 50 MiB，请分批提交。');
        documents.push({ path, bytes });
      }
      const lock = join(state.directory, 'index.lock');
      let handle;
      try { handle = await open(lock, 'wx', 0o600); }
      catch { throw new Error('已有 Git 索引锁，请等待其他 Git 操作完成。'); }
      await handle.close();
      let temporary = '';
      let advanced = false;
      let installed = false;
      try {
        temporary = await mkdtemp(join(state.directory, 'wudao-index-'));
        const index = join(temporary, 'index');
        await this.run(['read-tree', review.head], undefined, index);
        const entries = [];
        for (const document of documents) {
          const blob = document.bytes === null ? '0'.repeat(review.head.length) : (await this.run(['hash-object', '-w', '--stdin', '--no-filters'], document.bytes)).toString('utf8').trim();
          entries.push(`${document.bytes === null ? '0' : '100644'} ${blob}\t${document.path}\0`);
        }
        await this.run(['update-index', '-z', '--index-info'], entries.join(''), index);
        const tree = (await this.run(['write-tree'], undefined, index)).toString('utf8').trim();
        const commit = (await this.run(['commit-tree', tree, '-p', review.head], message.trim() + '\n')).toString('utf8').trim();
        const current = await this.guard();
        await this.changes();
        if (current.head !== review.head || current.branch !== review.branch) throw new Error('提交已变化，请重新检查。');
        await copyFile(index, lock);
        await this.run(['update-ref', '-m', 'Wudao Git: reviewed commit', `refs/heads/${review.branch}`, commit, review.head]);
        advanced = true;
        await rename(lock, join(state.directory, 'index'));
        installed = true;
        return commit;
      } finally {
        if (!advanced || installed) await rm(lock, { force: true });
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  private tracking(branch: string): string { return `refs/remotes/wudao-git/${branch}`; }

  protected async transfer(args: string[]): Promise<Buffer> { return this.run(args); }

  private async fetch(branch: string): Promise<string> {
    const tracking = this.tracking(branch);
    await this.transfer(['fetch', '--no-tags', '--no-recurse-submodules', this.url, `+refs/heads/${branch}:${tracking}`]);
    return this.text(['rev-parse', '--verify', tracking]);
  }

  private async ancestor(older: string, newer: string): Promise<boolean> {
    try { await this.run(['merge-base', '--is-ancestor', older, newer]); return true; }
    catch (error) { if (error instanceof GitError && error.code === 1) return false; throw error; }
  }

  private async inspectCommits(base: string, head: string): Promise<OutgoingCommit[]> {
    const hashes = (await this.text(['rev-list', '--reverse', `${base}..${head}`])).split('\n').filter(Boolean);
    if (hashes.length > 100) throw new Error('待同步提交超过 100 个，请使用外部 Git 检查。');
    const commits: OutgoingCommit[] = [];
    for (const hash of hashes) {
      if (SECRET.test(await this.text(['show', '-s', '--format=%B', hash]))) throw new Error('待同步提交说明包含疑似令牌或私钥，已停止同步。');
      const parents = (await this.text(['rev-list', '--parents', '-n', '1', hash])).split(' ');
      if (parents.length !== 2) throw new Error('待同步历史包含合并提交，请使用外部 Git 检查。');
      const files = (await this.run(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', parents[1]!, hash])).toString('utf8').split('\0').filter(Boolean);
      for (const path of files) {
        if (!allowedPath(path)) throw new Error('待同步历史包含不允许的文件，请使用外部 Git 检查。');
        const entry = (await this.run(['ls-tree', '-z', hash, '--', path])).toString('utf8');
        if (!entry) continue;
        if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob ')) throw new Error('待同步历史包含链接或子模块，已停止同步。');
        if (Number(await this.text(['cat-file', '-s', `${hash}:${path}`])) > MAX_BYTES) throw new Error('待同步文件超过 20 MiB，已停止同步。');
        if (SECRET.test((await this.run(['cat-file', 'blob', `${hash}:${path}`])).toString('utf8'))) throw new Error('待同步历史包含疑似令牌或私钥，已停止同步。');
      }
      commits.push({ hash, subject: await this.text(['show', '-s', '--format=%s', hash]), files });
    }
    return commits;
  }

  async reviewPush(): Promise<PushReview> {
    return this.exclusive(async () => {
      const state = await this.guard();
      const remoteHead = await this.fetch(state.branch);
      if (!await this.ancestor(remoteHead, state.head)) throw new Error('远端包含本地没有的提交或历史已分叉，请先拉取；分叉时使用外部 Git 处理。');
      return { head: state.head, branch: state.branch, remoteHead, commits: await this.inspectCommits(remoteHead, state.head) };
    });
  }

  async push(review: PushReview): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.guard();
      if (state.head !== review.head || state.branch !== review.branch) throw new Error('本地提交已变化，请重新检查待推送提交。');
      if (await this.fetch(state.branch) !== review.remoteHead) throw new Error('远端已变化，请重新检查待推送提交。');
      const commits = await this.inspectCommits(review.remoteHead, review.head);
      if (JSON.stringify(commits) !== JSON.stringify(review.commits)) throw new Error('待推送提交已变化，请重新检查。');
      if (commits.length) await this.transfer(['push', '--porcelain', this.url, `${review.head}:refs/heads/${review.branch}`]);
    });
  }

  async pull(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.guard();
      if ((await this.changes()).length) throw new Error('请先提交或处理本地改动，再拉取更新。');
      const remoteHead = await this.fetch(state.branch);
      if (remoteHead === state.head) return;
      if (!await this.ancestor(state.head, remoteHead)) throw new Error('历史已分叉，已停止拉取，请使用外部 Git 处理。');
      await this.inspectCommits(state.head, remoteHead);
      const current = await this.guard();
      if (current.head !== state.head || current.branch !== state.branch || (await this.changes()).length) throw new Error('本地状态已变化，请重新拉取。');
      await this.run(['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', remoteHead]);
    });
  }
}
