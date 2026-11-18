import { GitHubClient, type RemoteTree } from './github.ts';
import type { ApplyEntry, BaselineFile, Confirmation, LocalFiles, MobileChange, MobileReview, MobileState, PullPlan, Resolution, StateStore } from './types.ts';
import { allowedPath, binding, blobSha, budget, checkBytes, checkPaths, checkSecret, fromBase64, MAX_FILE_BYTES, object, sha, toBase64, validSha } from './policy.ts';

type Snapshot = Record<string, BaselineFile>;
interface Scan { files: Snapshot; blocked: MobileChange[]; visible: string[]; paths: string[]; directories: string[] }
interface StoredPlan { plan: PullPlan; remote: RemoteTree; local: Snapshot; entries: ApplyEntry[]; base: Snapshot; baseHead: string }
const deleted = 'deleted';
const identity = (file: BaselineFile | undefined) => file?.sha ?? deleted;
const keys = (...maps: object[]) => [...new Set(maps.flatMap(map => Object.keys(map)))].sort();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameSnapshot = (left: Snapshot, right: Snapshot) => keys(left, right).every(path => identity(left[path]) === identity(right[path]) && left[path]?.size === right[path]?.size);

export class MobileEngine {
  private readonly repository: string;
  private readonly branch: string;
  private readonly files: LocalFiles;
  private readonly store: StateStore;
  private readonly client: GitHubClient;
  private busy = false;
  private plans = new Map<string, StoredPlan>();
  constructor(options: { repository: string; branch?: string; files: LocalFiles; store: StateStore; client: GitHubClient }) {
    this.repository = options.repository; this.branch = options.branch ?? 'main';
    binding(this.repository, this.branch);
    if (options.client.repository !== this.repository || options.client.branch !== this.branch) throw new Error('客户端仓库绑定不一致。');
    this.files = options.files; this.store = options.store; this.client = options.client;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('已有同步操作正在进行。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  private baseline(value: unknown): asserts value is Snapshot {
    for (const [path, raw] of Object.entries(object(value))) {
      const file = object(raw);
      if (!allowedPath(path) || !validSha(file.sha) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error('同步基线状态无效，请保留本地文件并检查状态备份。');
    }
    checkPaths(Object.keys(object(value)));
  }
  private bodies(files: Record<string, string | null>): number {
    let size = 0;
    for (const [path, body] of Object.entries(object(files))) {
      if (!allowedPath(path) || body !== null && typeof body !== 'string') throw new Error('同步快照状态无效。');
      size += body === null ? 0 : fromBase64(body as string).length;
      budget(size);
    }
    return size;
  }
  private async state(): Promise<MobileState> {
    const loaded = await this.store.load();
    if (!loaded) return { version: 1, repository: this.repository, branch: this.branch, head: '', baseline: {} };
    if (loaded.version !== 1 || loaded.repository !== this.repository || loaded.branch !== this.branch) throw new Error('同步状态与当前仓库或分支绑定不一致（binding）。');
    if (loaded.head !== '') sha(loaded.head);
    this.baseline(loaded.baseline);
    if (!loaded.head && Object.keys(loaded.baseline).length) throw new Error('未初始化的同步基线状态无效。');
    if (loaded.draft) {
      this.bodies(loaded.draft.files);
      const review = object(loaded.draft.review);
      if (typeof review.id !== 'string' || review.head !== loaded.head || !Array.isArray(review.changes)) throw new Error('审阅状态无效。');
      for (const change of loaded.draft.review.changes) {
        if (typeof change.path !== 'string' || typeof change.allowed !== 'boolean' || typeof change.reason !== 'string' || !['add', 'modify', 'delete'].includes(change.status)) throw new Error('审阅状态无效。');
        if (change.allowed && (!allowedPath(change.path) || !(change.path in loaded.draft.files) || change.digest !== deleted && !validSha(change.digest))) throw new Error('审阅快照无效。');
      }
    }
    if (loaded.pending) {
      sha(loaded.pending.commit); sha(loaded.pending.parent);
      if (Object.keys(object(loaded.pending.files)).some(path => !allowedPath(path))) throw new Error('待上传文件状态无效。');
      this.baseline(Object.fromEntries(Object.entries(object(loaded.pending.files)).filter(([, file]) => file !== null)));
      if (loaded.pending.parent !== loaded.head) throw new Error('待上传提交状态无效。');
    }
    if (loaded.journal) {
      sha(loaded.journal.head); this.baseline(loaded.journal.baseline);
      if (!Array.isArray(loaded.journal.entries)) throw new Error('本地写入日志无效。');
      let total = 0;
      for (const entry of loaded.journal.entries) total += this.bodies({ [entry.path]: entry.before }) + this.bodies({ [entry.path]: entry.after });
      budget(total);
      checkPaths(loaded.journal.entries.map(entry => entry.path));
    }
    return loaded;
  }
  private ready(state: MobileState): void {
    if (state.journal) throw new Error('上次本地写入中断，请先恢复。');
  }
  private async read(path: string): Promise<Uint8Array | null> {
    if (!allowedPath(path)) throw new Error('文件路径不在允许范围内。');
    const bytes = await this.files.read(path);
    if (bytes !== null) checkBytes(bytes);
    return bytes;
  }
  private async scan(): Promise<Scan> {
    const entries = await this.files.list();
    if (entries.some(entry => !['file', 'directory', 'symlink'].includes(entry.kind))) throw new Error('本地文件类型无效。');
    const paths = entries.filter(entry => entry.kind !== 'directory').map(entry => entry.path);
    const directories = entries.filter(entry => entry.kind === 'directory').map(entry => entry.path);
    checkPaths(paths, directories);
    if (entries.some(entry => entry.kind === 'symlink')) throw new Error('文库包含链接（symlink），请改用普通文件。');
    const files: Snapshot = Object.create(null) as Snapshot;
    const blocked: MobileChange[] = [];
    const visible: string[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      if (entry.path.split('/').some(part => part.startsWith('.'))) continue;
      visible.push(entry.path);
      if (!allowedPath(entry.path)) { blocked.push({ path: entry.path, status: 'add', allowed: false, reason: '路径或类型不在移动端共享允许范围内。', digest: '' }); continue; }
      try {
        const bytes = await this.read(entry.path);
        if (bytes === null) throw new Error('文件读取期间发生变化，请重试。');
        files[entry.path] = { sha: await blobSha(bytes), size: bytes.length };
      } catch {
        blocked.push({ path: entry.path, status: 'modify', allowed: false, reason: '文件无法安全读取，可能包含密钥、超过大小限制或读取期间变化。', digest: '' });
      }
    }
    return { files, blocked, visible, paths, directories };
  }
  private async snapshot(path: string, expected: BaselineFile | undefined): Promise<string | null> {
    const bytes = await this.read(path);
    if ((bytes === null ? deleted : await blobSha(bytes)) !== identity(expected)) throw new Error('本地文件已变化，请重新检查。');
    return bytes === null ? null : toBase64(bytes);
  }
  async status(): Promise<{ initialized: boolean; recovery: boolean; pendingUpload: boolean }> {
    return this.exclusive(async () => { const state = await this.state(); return { initialized: !!state.head, recovery: !!state.journal, pendingUpload: !!state.pending }; });
  }
  async review(): Promise<MobileReview> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      if (!state.head) throw new Error('请先将 GitHub 分支导入空文库。');
      if (state.pending) throw new Error('上次上传结果待核对，请先重试上传或恢复。');
      const scan = await this.scan();
      const changes = [...scan.blocked];
      const snapshots: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
      let size = 0;
      for (const path of keys(state.baseline, scan.files)) {
        if (scan.blocked.some(change => change.path === path) || identity(state.baseline[path]) === identity(scan.files[path])) continue;
        size += scan.files[path]?.size ?? 0; budget(size);
        snapshots[path] = await this.snapshot(path, scan.files[path]);
        changes.push({ path, status: !scan.files[path] ? 'delete' : state.baseline[path] ? 'modify' : 'add', digest: identity(scan.files[path]), allowed: true, reason: '' });
      }
      const review = { id: crypto.randomUUID(), head: state.head, changes: changes.sort((a,b) => a.path.localeCompare(b.path)) };
      state.draft = { review, files: snapshots };
      await this.store.save(state);
      return clone(review);
    });
  }
  private draft(state: MobileState, review: MobileReview) {
    if (!state.draft || state.draft.review.id !== review.id || state.draft.review.head !== state.head) throw new Error('审阅已失效，请重新检查。');
    return state.draft;
  }
  async preview(review: MobileReview, path: string): Promise<string> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      const draft = this.draft(state, review);
      const change = draft.review.changes.find(change => change.path === path && change.allowed);
      if (!change) throw new Error('请选择允许预览的已审阅文件。');
      const bytes = await this.read(path);
      if ((bytes === null ? deleted : await blobSha(bytes)) !== change.digest) throw new Error('文件已变化，请重新检查。');
      return `基线：${state.baseline[path]?.sha ?? '新文件'}；离线预览仅显示当前快照。\n当前内容\n${this.display(path, draft.files[path] ?? null)}`;
    });
  }
  private display(path: string, body: string | null): string {
    if (body === null) return '（文件已删除）';
    const bytes = fromBase64(body);
    if (!/\.(md|txt|csv)$/i.test(path) || bytes.includes(0)) return `附件：${bytes.length} 字节；请在 Obsidian 打开检查。`;
    return new TextDecoder().decode(bytes).slice(0, 50000);
  }
  async planPull(): Promise<PullPlan> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      if (state.pending) {
        if (await this.client.head() === state.pending.commit) await this.finishUpload(state, false);
        else { delete state.pending; await this.store.save(state); }
      }
      const local = await this.scan();
      if (!state.head && local.visible.length) throw new Error('首次导入仅允许空文档文库（empty vault）。');
      if (local.blocked.some(change => allowedPath(change.path))) throw new Error('本地文档无法安全读取，请先检查。');
      const remote = await this.client.snapshot();
      checkPaths([...new Set([...local.paths, ...remote.paths])], local.directories);
      const plan: PullPlan = { id: crypto.randomUUID(), head: remote.head, initial: !state.head, changes: [], deletions: [] };
      const entries: ApplyEntry[] = [];
      let size = 0;
      for (const path of keys(state.baseline, local.files, remote.files)) {
        const base = identity(state.baseline[path]), current = identity(local.files[path]), incoming = identity(remote.files[path]);
        if (base === current && base === incoming) continue;
        const kind = current === incoming ? 'same' : incoming === base ? 'local' : current === base ? 'remote' : 'conflict';
        plan.changes.push({ path, kind, deleted: incoming === deleted });
        if ((kind === 'remote' || kind === 'conflict') && incoming === deleted && current !== deleted) plan.deletions.push(path);
        if (kind === 'remote' || kind === 'conflict') {
          size += (local.files[path]?.size ?? 0) + (remote.files[path]?.size ?? 0); budget(size);
          const before = await this.snapshot(path, local.files[path]);
          const file = remote.files[path];
          entries.push({ path, before, after: file ? toBase64(await this.client.blob(file)) : null });
        }
      }
      this.plans.clear();
      this.plans.set(plan.id, { plan: clone(plan), remote, local: local.files, entries, base: state.baseline, baseHead: state.head });
      return plan;
    });
  }
  async previewPull(plan: PullPlan, path: string): Promise<string> {
    return this.exclusive(async () => {
      const stored = this.plans.get(plan.id);
      if (!stored || !stored.plan.changes.some(change => change.path === path)) throw new Error('下载审阅已失效，请重新检查。');
      const entry = stored.entries.find(entry => entry.path === path);
      const base = stored.base[path];
      const total = (base?.size ?? 0) + (stored.local[path]?.size ?? 0) + (stored.remote.files[path]?.size ?? 0); budget(total);
      const before = base ? toBase64(await this.client.blob(base)) : null;
      const local = entry?.before ?? await this.snapshot(path, stored.local[path]);
      const file = stored.remote.files[path];
      const incoming = entry ? entry.after : file ? toBase64(await this.client.blob(file)) : null;
      return `基线\n${this.display(path, before)}\n\n本地\n${this.display(path, local)}\n\n远端\n${this.display(path, incoming)}`;
    });
  }
  private confirm(paths: string[], confirmation?: Confirmation): void {
    if (!paths.length) return;
    if (!confirmation || new Set(confirmation.deletions).size !== confirmation.deletions.length || JSON.stringify([...paths].sort()) !== JSON.stringify([...confirmation.deletions].sort())) throw new Error('请明确确认本次预览中的删除文件（deletions）。');
    if (paths.length >= 2 && !confirmation.bulkDelete) throw new Error('批量删除（bulk delete）需要额外确认。');
  }
  async applyPull(plan: PullPlan, resolutions: Record<string, Resolution> = {}, confirmation?: Confirmation): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      const stored = this.plans.get(plan.id);
      if (!stored || state.head !== stored.baseHead || !sameSnapshot(state.baseline, stored.base)) throw new Error('下载审阅已失效，请重新检查。');
      if (state.pending) throw new Error('请先核对上次上传。');
      for (const change of stored.plan.changes) if (change.kind === 'conflict' && !['local', 'remote', 'both'].includes(resolutions[change.path] ?? '')) throw new Error('存在冲突（conflict），请逐个选择本地、远端或两者。');
      const local = await this.scan();
      checkPaths([...new Set([...local.paths, ...stored.remote.paths])], local.directories);
      if (stored.plan.initial && local.visible.length || local.blocked.some(change => allowedPath(change.path)) || !sameSnapshot(local.files, stored.local)) throw new Error('本地文件已变化，请重新检查。');
      if (await this.client.head() !== stored.remote.head) throw new Error('远端已变化，请重新检查。');
      const entries: ApplyEntry[] = [];
      const existing = new Set([...local.paths, ...local.directories, ...stored.remote.paths]);
      for (const entry of stored.entries) {
        const conflict = stored.plan.changes.find(change => change.path === entry.path)?.kind === 'conflict';
        if (conflict && resolutions[entry.path] === 'local') continue;
        if (conflict && resolutions[entry.path] === 'both' && entry.before !== null) {
          const dot = entry.path.lastIndexOf('.');
          let path = `${entry.path.slice(0, dot)}.local-copy${entry.path.slice(dot)}`;
          let suffix = 1;
          while ([...existing].some(existing => existing.normalize('NFC').toLowerCase() === path.normalize('NFC').toLowerCase())) path = `${entry.path.slice(0, dot)}.local-copy-${suffix++}${entry.path.slice(dot)}`;
          existing.add(path);
          entries.push({ path, before: null, after: entry.before });
        }
        entries.push(entry);
      }
      this.confirm(entries.filter(entry => entry.after === null && entry.before !== null).map(entry => entry.path), confirmation);
      let size = 0;
      for (const entry of entries) { size += this.bodies({ [entry.path]: entry.before }) + this.bodies({ [entry.path]: entry.after }); budget(size); }
      // The head check awaited network I/O. Enumerate the complete inventory
      // again so a newly created empty directory cannot poison the journal.
      const latest = await this.files.list();
      if (latest.some(entry => !['file', 'directory', 'symlink'].includes(entry.kind) || entry.kind === 'symlink')) throw new Error('本地文件类型无效或包含链接，请重新检查。');
      const paths = latest.filter(entry => entry.kind === 'file').map(entry => entry.path);
      const directories = latest.filter(entry => entry.kind === 'directory').map(entry => entry.path);
      checkPaths(paths, directories);
      checkPaths([...new Set([...paths, ...stored.remote.paths, ...entries.map(entry => entry.path)])], directories);
      if (stored.plan.initial && paths.some(path => !path.split('/').some(part => part.startsWith('.')))) throw new Error('首次导入期间文库已变化，请重新检查。');
      state.journal = { head: stored.remote.head, baseline: stored.remote.files, entries };
      delete state.draft;
      await this.store.save(state);
      await this.finishJournal(state);
      this.plans.clear();
    });
  }
  private async finishJournal(state: MobileState): Promise<{ pending: boolean; preserved: string[] }> {
    const journal = state.journal;
    if (!journal) return { pending: false, preserved: [] };
    const preserved: string[] = [];
    for (const entry of journal.entries) {
      // Later user edits may now contain a secret. Compare without exporting or
      // persisting that content so recovery can still preserve those edits.
      const actual = await this.files.read(entry.path);
      const current = actual === null ? null : toBase64(actual);
      if (current === entry.after) continue;
      if (current !== entry.before) {
        // A partial host write and a later user edit cannot be distinguished.
        // Keep the current file and retain the original bytes as a normal copy.
        if (entry.before !== null) await this.backup(entry.path, entry.before);
        preserved.push(entry.path); continue;
      }
      if (entry.after === null) await this.files.remove(entry.path);
      if (entry.after !== null) await this.files.write(entry.path, fromBase64(entry.after));
      const checked = await this.files.read(entry.path);
      if ((checked === null ? null : toBase64(checked)) !== entry.after) throw new Error('本地写入验证失败，请先恢复。');
    }
    state.head = journal.head; state.baseline = journal.baseline;
    delete state.journal; delete state.draft;
    await this.store.save(state);
    return { pending: false, preserved };
  }
  private async backup(source: string, body: string): Promise<void> {
    const dot = source.lastIndexOf('.');
    const entries = await this.files.list();
    const paths = new Set(entries.map(entry => entry.path.normalize('NFC').toLowerCase()));
    for (let suffix = 0; suffix < 10000; suffix++) {
      const path = `${source.slice(0, dot)}.recovery-copy${suffix ? `-${suffix}` : ''}${source.slice(dot)}`;
      if (paths.has(path.normalize('NFC').toLowerCase())) {
        if (!entries.some(entry => entry.path === path && entry.kind === 'file')) continue;
        const existing = await this.files.read(path);
        if (existing !== null && existing.length <= MAX_FILE_BYTES && toBase64(existing) === body) return;
        continue;
      }
      checkPaths([...entries.filter(entry => entry.kind !== 'directory').map(entry => entry.path), path], entries.filter(entry => entry.kind === 'directory').map(entry => entry.path));
      const bytes = fromBase64(body);
      await this.files.write(path, bytes);
      const checked = await this.files.read(path);
      if (checked === null || toBase64(checked) !== body) throw new Error('恢复备份写入验证失败，原始备份仍保留在日志中。');
      return;
    }
    throw new Error('恢复备份文件名冲突过多，原始备份仍保留在日志中。');
  }
  private async finishUpload(state: MobileState, publish = true): Promise<string> {
    const pending = state.pending;
    if (!pending) throw new Error('没有待恢复的上传。');
    const current = await this.client.head();
    if (current !== pending.commit) {
      if (!publish) throw new Error('远端核对期间发生变化，请重新检查。');
      if (current !== pending.parent) throw new Error('远端已变化，待上传提交仍保留，请核对后重新下载审阅。');
      await this.client.updateRef(pending.commit);
    }
    for (const [path, file] of Object.entries(pending.files)) {
      if (!allowedPath(path)) throw new Error('待上传文件状态无效。');
      if (file === null) { delete state.baseline[path]; continue; }
      state.baseline[path] = file;
    }
    state.head = pending.commit;
    delete state.pending; delete state.draft;
    await this.store.save(state);
    return pending.commit;
  }
  async recover(): Promise<{ pending: boolean; preserved: string[] }> {
    return this.exclusive(async () => {
      const state = await this.state();
      if (state.journal) return this.finishJournal(state);
      // Checking a timed-out publication is read-only. Retrying a ref write still
      // requires the explicit upload action that originally approved this commit.
      if (state.pending) {
        if (await this.client.head() !== state.pending.commit) return { pending: true, preserved: [] };
        await this.finishUpload(state, false);
      }
      return { pending: false, preserved: [] };
    });
  }
  async upload(review: MobileReview, selected: string[], message: string, confirmation?: Confirmation): Promise<string> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      if (state.pending) {
        this.draft(state, review);
        if (new Set(selected).size !== selected.length || JSON.stringify([...selected].sort()) !== JSON.stringify(Object.keys(state.pending.files).sort())) throw new Error('待上传提交已固定，请按原选择重试，或重新下载审阅。');
        return this.finishUpload(state);
      }
      const draft = this.draft(state, review);
      if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择需要上传的文件。');
      if (!message.trim() || message.length > 1000 || message.includes('\0')) throw new Error('提交说明不能为空且最多 1000 个字符。');
      checkSecret(message);
      const snapshots: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
      let size = 0;
      for (const path of selected) {
        const change = draft.review.changes.find(change => change.path === path && change.allowed);
        if (!change) throw new Error('选择包含未审阅或不允许的文件。');
        const bytes = await this.read(path);
        if ((bytes === null ? deleted : await blobSha(bytes)) !== change.digest) throw new Error('文件已变化，请重新检查。');
        const snapshot = draft.files[path];
        if (snapshot === undefined || (snapshot === null ? deleted : await blobSha(fromBase64(snapshot))) !== change.digest) throw new Error('上传快照校验失败。');
        size += bytes?.length ?? 0; budget(size);
        snapshots[path] = snapshot;
      }
      this.confirm(selected.filter(path => snapshots[path] === null), confirmation);
      const remote = await this.client.snapshot();
      if (remote.head !== state.head) throw new Error('远端已变化，请先下载并重新审阅。');
      const proposed = new Set(remote.paths);
      for (const [path, body] of Object.entries(snapshots)) {
        if (body === null) proposed.delete(path);
        else proposed.add(path);
      }
      // Excluded files remain in base_tree. They must participate in namespace
      // checks too, before creating even an unattached blob on the remote.
      checkPaths([...proposed]);
      const treeFiles: { path: string; sha: string | null }[] = [];
      // The reviewed snapshot was persisted by review(), before the first POST.
      for (const [path, body] of Object.entries(snapshots)) treeFiles.push({ path, sha: body === null ? null : await this.client.createBlob(fromBase64(body)) });
      const tree = await this.client.createTree(remote.tree, treeFiles);
      const commit = await this.client.createCommit(tree, remote.head, message.trim());
      const published: Record<string, BaselineFile | null> = {};
      for (const file of treeFiles) published[file.path] = file.sha === null ? null : { sha: file.sha, size: fromBase64(snapshots[file.path]!).length };
      state.pending = { commit, parent: remote.head, files: published };
      await this.store.save(state);
      return this.finishUpload(state);
    });
  }
}
