import { GitHubClient, GitHubError, type RemoteTree } from './github.ts';
import type { ApplyEntry, ApplyPullResult, BaselineFile, Confirmation, HistoryEntry, HistoryFile, LocalFiles, MobileChange, MobileInspection, MobileReview, MobileState, PullPlan, Resolution, StateStore } from './types.ts';
import { allowedDirectory, allowedPath, binding, blobSha, budget, checkBytes, checkPaths, checkSecret, fromBase64, MAX_FILE_BYTES, object, sha, toBase64, validSha } from './policy.ts';

type Snapshot = Record<string, BaselineFile>;
interface Scan { files: Snapshot; blocked: MobileChange[]; visible: string[]; paths: string[]; directories: string[] }
interface StoredPlan { plan: PullPlan; remote: RemoteTree; local: Snapshot; entries: ApplyEntry[]; base: Snapshot; baseHead: string; repair?: string }
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
    for (const [name, snapshot] of [['draft', loaded.draft], ['staged', loaded.staged]] as const) if (snapshot) {
      this.bodies(snapshot.files);
      const review = object(snapshot.review);
      if (typeof review.id !== 'string' || !validSha(review.head) || name === 'draft' && review.head !== loaded.head || !Array.isArray(review.changes)
        || 'index' in review && typeof review.index !== 'string') throw new Error('审阅状态无效。');
      checkPaths(snapshot.review.changes.map(change => change.path));
      for (const change of snapshot.review.changes) {
        if (typeof change.path !== 'string' || typeof change.allowed !== 'boolean' || typeof change.reason !== 'string' || !['add', 'modify', 'delete'].includes(change.status)) throw new Error('审阅状态无效。');
        if (change.allowed && (!allowedPath(change.path) || !(change.path in snapshot.files) || change.digest !== deleted && !validSha(change.digest))) throw new Error('审阅快照无效。');
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
      const directories = loaded.journal.directories ?? [];
      if (!Array.isArray(directories) || directories.some(path => typeof path !== 'string' || !allowedDirectory(path))) throw new Error('本地目录写入日志无效。');
      checkPaths(loaded.journal.entries.map(entry => entry.path), directories);
      if (loaded.journal.inventory) {
        const inventory = object(loaded.journal.inventory);
        if (!Array.isArray(inventory.files) || !Array.isArray(inventory.directories)
          || [...inventory.files, ...inventory.directories].some(path => typeof path !== 'string')) throw new Error('远端路径日志无效。');
        checkPaths(inventory.files as string[], inventory.directories as string[]);
        checkPaths([...new Set([...inventory.files as string[], ...loaded.journal.entries.map(entry => entry.path)])], [...new Set([...inventory.directories as string[], ...directories])]);
      }
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
  private async remoteBody(path: string, file: BaselineFile): Promise<string> {
    try { return toBase64(await this.client.blob(file)); }
    catch (error) { throw new Error(`远端文件 ${path} 无法安全下载：${error instanceof Error ? error.message : '文件校验失败。'}`); }
  }
  async status(): Promise<{ initialized: boolean; recovery: boolean; pendingUpload: boolean }> {
    return this.exclusive(async () => { const state = await this.state(); return { initialized: !!state.head, recovery: !!state.journal, pendingUpload: !!state.pending }; });
  }
  private changes(state: MobileState, scan: Scan): MobileChange[] {
    return [...scan.blocked, ...keys(state.baseline, scan.files).filter(path => !scan.blocked.some(change => change.path === path)
      && identity(state.baseline[path]) !== identity(scan.files[path])).map(path => ({
      path, status: !scan.files[path] ? 'delete' as const : state.baseline[path] ? 'modify' as const : 'add' as const,
      digest: identity(scan.files[path]), allowed: true, reason: '',
    }))].sort((a,b) => a.path.localeCompare(b.path));
  }
  private async workingChanges(state: MobileState, scan: Scan): Promise<MobileChange[]> {
    const baseline = { ...state.baseline };
    for (const [path, body] of Object.entries(state.staged?.files ?? {})) {
      if (body === null) { delete baseline[path]; continue; }
      const bytes = fromBase64(body); baseline[path] = { sha: await blobSha(bytes), size: bytes.length };
    }
    return this.changes({ ...state, baseline }, scan);
  }
  async inspectVault(): Promise<MobileInspection> {
    return this.exclusive(async () => {
      const state = await this.state(); const scan = await this.scan();
      return { repository: this.repository, branch: this.branch, head: state.head, initialized: !!state.head,
        recovery: !!state.journal, pendingUpload: !!state.pending, changes: this.changes(state, scan),
        workingChanges: await this.workingChanges(state, scan), staged: clone(state.staged?.review ?? null) };
    });
  }
  async review(): Promise<MobileReview> { return this.createReview(false); }
  async reviewWorking(): Promise<MobileReview> { return this.createReview(true); }
  private async createReview(working: boolean): Promise<MobileReview> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      if (!state.head) throw new Error('请先连接现有文库，或检查远端并建立同步关系。');
      if (state.pending) throw new Error('上次上传结果待核对，请先重试上传或恢复。');
      const scan = await this.scan();
      const changes = working ? await this.workingChanges(state, scan) : this.changes(state, scan);
      const snapshots: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
      let size = 0;
      for (const change of changes) {
        if (!change.allowed) continue;
        const path = change.path;
        size += scan.files[path]?.size ?? 0; budget(size);
        snapshots[path] = await this.snapshot(path, scan.files[path]);
      }
      const review: MobileReview = { id: crypto.randomUUID(), head: state.head, changes: changes.sort((a,b) => a.path.localeCompare(b.path)),
        ...(working ? { index: state.staged?.review.id ?? '' } : {}) };
      state.draft = { review, files: snapshots };
      await this.store.save(state);
      return clone(review);
    });
  }
  private draft(state: MobileState, review: MobileReview) {
    const draft = state.staged?.review.id === review.id ? state.staged : state.draft;
    if (!draft || draft.review.id !== review.id || draft.review.head !== state.head) throw new Error('审阅或暂存基线已失效，请重新检查；原暂存快照仍保留。');
    if (draft.review.index !== undefined && draft.review.index !== (state.staged?.review.id ?? '')) throw new Error('暂存区在审阅后发生变化，请重新检查工作区。');
    return draft;
  }
  async stage(review: MobileReview, selected: string[]): Promise<MobileReview> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      if (state.pending) throw new Error('请先核对上次上传。');
      const draft = this.draft(state, review);
      if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择需要暂存的文件。');
      if (state.staged && state.staged.review.head !== state.head) throw new Error('暂存基线已变化，请先取消原暂存再重新选择；本地文件不会删除。');
      const files = clone(state.staged?.files ?? {});
      for (const path of selected) {
        const change = draft.review.changes.find(change => change.path === path && change.allowed);
        if (!change) throw new Error('选择包含未审阅或不允许的文件。');
        if (draft !== state.staged) await this.snapshot(path, change.digest === deleted ? undefined : { sha: change.digest, size: 0 });
        const body = draft.files[path];
        if (body === undefined || (body === null ? deleted : await blobSha(fromBase64(body))) !== change.digest) throw new Error('暂存快照校验失败。');
        files[path] = body;
      }
      this.bodies(files);
      const changes: MobileChange[] = [];
      for (const [path, body] of Object.entries(files)) {
        const digest = body === null ? deleted : await blobSha(fromBase64(body));
        if (digest === identity(state.baseline[path])) { delete files[path]; continue; }
        changes.push({ path, status: body === null ? 'delete' : state.baseline[path] ? 'modify' : 'add', digest, allowed: true, reason: '' });
      }
      const staged = { id: crypto.randomUUID(), head: state.head, changes: changes.sort((a,b) => a.path.localeCompare(b.path)) };
      if (changes.length) state.staged = { review: staged, files };
      else delete state.staged;
      await this.store.save(state); return clone(staged);
    });
  }
  async unstage(paths: string[]): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      if (state.pending) throw new Error('请先核对上次上传。');
      if (!state.staged) return;
      if (paths.some(path => !state.staged!.review.changes.some(change => change.path === path))) throw new Error('取消暂存的文件不在当前选择中。');
      for (const path of paths) delete state.staged.files[path];
      state.staged.review.changes = state.staged.review.changes.filter(change => !paths.includes(change.path));
      state.staged.review.id = crypto.randomUUID();
      if (!state.staged.review.changes.length) delete state.staged;
      await this.store.save(state);
    });
  }
  async history(limit = 20): Promise<HistoryEntry[]> {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('历史条数必须为 1 到 50。');
      const result: HistoryEntry[] = []; const seen = new Set<string>(); let current: string | undefined = await this.client.head();
      while (current && result.length < limit) {
        if (seen.has(current)) throw new Error('GitHub 提交历史包含循环。');
        seen.add(current); const entry = await this.client.commit(current);
        result.push({ hash: entry.hash, subject: entry.subject, date: entry.date }); current = entry.parents[0];
      }
      return result;
    });
  }
  private async historyTrees(id: string) {
    const commit = await this.client.commit(sha(id));
    const after = await this.client.snapshot(commit.hash);
    const before = commit.parents[0] ? await this.client.snapshot(commit.parents[0]) : null;
    return { after, before };
  }
  async historyFiles(id: string): Promise<HistoryFile[]> {
    return this.exclusive(async () => {
      const { after, before } = await this.historyTrees(id);
      const incoming = after.leafShas ?? {}; const previous = before?.leafShas ?? {};
      return keys(incoming, previous).filter(path => incoming[path] !== previous[path])
        .map(path => ({ path, status: !incoming[path] ? 'delete' : !previous[path] ? 'add' : 'modify' }));
    });
  }
  async historyPreview(id: string, path: string): Promise<string> {
    return this.exclusive(async () => {
      if (!allowedPath(path)) throw new Error('此历史文件不在允许查看范围。');
      const { after, before } = await this.historyTrees(id); const previous = before?.files[path]; const current = after.files[path];
      if (identity(previous) === identity(current)) throw new Error('此文件不在该提交的变化中。');
      budget((previous?.size ?? 0) + (current?.size ?? 0));
      return `提交 ${sha(id)}\n提交前\n${this.display(path, previous ? await this.remoteBody(path, previous) : null)}\n\n提交后\n${this.display(path, current ? await this.remoteBody(path, current) : null)}`;
    });
  }
  async preview(review: MobileReview, path: string, options: { remote?: boolean } = {}): Promise<string> {
    return this.exclusive(async () => {
      const state = await this.state(); this.ready(state);
      const draft = this.draft(state, review);
      const change = draft.review.changes.find(change => change.path === path && change.allowed);
      if (!change) throw new Error('请选择允许预览的已审阅文件。');
      if (draft !== state.staged) {
        const bytes = await this.read(path);
        if ((bytes === null ? deleted : await blobSha(bytes)) !== change.digest) throw new Error('文件已变化，请重新检查。');
      }
      let before = '（新文件，无基线正文）';
      const file = state.baseline[path];
      let label = file?.sha ?? '新文件';
      if (draft.review.index !== undefined && state.staged && path in state.staged.files) {
        before = this.display(path,state.staged.files[path]!); label = '暂存区';
      } else if (file) {
        before = '（基线正文未缓存，联网查看差异时可读取）';
        if (options.remote) {
          try { before = this.display(path, toBase64(await this.client.blob(file))); }
          catch (error) { if (!(error instanceof GitHubError) || error.status !== 0) throw error; before = '（基线正文未缓存，请联网后查看差异）'; }
        }
      }
      return `基线：${label}\n${before}\n\n${draft === state.staged ? '已暂存快照' : '当前快照'}\n${this.display(path, draft.files[path] ?? null)}`;
    });
  }
  private display(path: string, body: string | null): string {
    if (body === null) return '（文件已删除）';
    const bytes = fromBase64(body);
    if (!/\.(md|txt|csv)$/i.test(path) || bytes.includes(0)) return `附件：${bytes.length} 字节；请在 Obsidian 打开检查。`;
    return new TextDecoder().decode(bytes).slice(0, 50000);
  }
  async planPull(): Promise<PullPlan> { return this.plan(false); }
  async planAttach(options: { repair?: boolean } = {}): Promise<PullPlan> { return this.plan(true, options.repair === true); }
  private async plan(attach: boolean, repair = false): Promise<PullPlan> {
    return this.exclusive(async () => {
      let state: MobileState; let token: string | undefined;
      try { state = await this.state(); }
      catch (error) {
        if (!attach || !repair || !this.store.prepareRepair || !this.store.repair) throw error;
        token = await this.store.prepareRepair(this.repository, this.branch);
        state = { version: 1, repository: this.repository, branch: this.branch, head: '', baseline: {} };
      }
      this.ready(state);
      if (attach && state.head) throw new Error('当前同步记录有效，请直接检查远端更新。');
      if (state.pending) {
        if (await this.client.head() === state.pending.commit) await this.finishUpload(state, false);
        else { delete state.pending; await this.store.save(state); }
      }
      const local = await this.scan();
      if (!attach && !state.head && local.visible.length) throw new Error('当前文库已有文档，请使用“连接现有文库”；首次导入仅允许空文档文库（empty vault）。');
      const blocked = local.blocked.find(change => allowedPath(change.path));
      if (blocked) throw new Error(`本地文件 ${blocked.path} 无法安全读取，请先检查。`);
      const remote = await this.client.snapshot();
      checkPaths([...new Set([...local.paths, ...remote.paths])], [...new Set([...local.directories, ...remote.directories])]);
      const plan: PullPlan = {
        id: crypto.randomUUID(), head: remote.head, initial: !state.head, changes: [], deletions: [], ...(attach ? { attach: true } : {}),
        directories: remote.directories.filter(path => allowedDirectory(path) && !local.directories.includes(path)).sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
        summary: { remoteFiles: remote.totalFiles, managedFiles: Object.keys(remote.files).length, remoteDirectories: remote.totalDirectories, excluded: clone(remote.excluded) },
      };
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
          entries.push({ path, before, after: file ? await this.remoteBody(path, file) : null });
        }
      }
      this.plans.clear();
      this.plans.set(plan.id, { plan: clone(plan), remote, local: local.files, entries, base: state.baseline, baseHead: state.head, ...(token ? { repair: token } : {}) });
      return plan;
    });
  }
  async applyAttach(plan: PullPlan, resolutions: Record<string, Resolution> = {}, confirmation?: Confirmation): Promise<ApplyPullResult> {
    if (!this.plans.get(plan.id)?.plan.attach) throw new Error('请先检查连接现有文库的计划。');
    return this.applyPull(plan, resolutions, confirmation);
  }
  async previewPull(plan: PullPlan, path: string): Promise<string> {
    return this.exclusive(async () => {
      const stored = this.plans.get(plan.id);
      if (!stored || !stored.plan.changes.some(change => change.path === path)) throw new Error('下载审阅已失效，请重新检查。');
      const entry = stored.entries.find(entry => entry.path === path);
      const base = stored.base[path];
      const total = (base?.size ?? 0) + (stored.local[path]?.size ?? 0) + (stored.remote.files[path]?.size ?? 0); budget(total);
      const before = base ? await this.remoteBody(path, base) : null;
      const local = entry?.before ?? await this.snapshot(path, stored.local[path]);
      const file = stored.remote.files[path];
      const incoming = entry ? entry.after : file ? await this.remoteBody(path, file) : null;
      return `基线\n${this.display(path, before)}\n\n本地\n${this.display(path, local)}\n\n远端\n${this.display(path, incoming)}`;
    });
  }
  private confirm(paths: string[], confirmation?: Confirmation): void {
    if (!paths.length) return;
    if (!confirmation || new Set(confirmation.deletions).size !== confirmation.deletions.length || JSON.stringify([...paths].sort()) !== JSON.stringify([...confirmation.deletions].sort())) throw new Error('请明确确认本次预览中的删除文件（deletions）。');
    if (paths.length >= 2 && !confirmation.bulkDelete) throw new Error('批量删除（bulk delete）需要额外确认。');
  }
  async applyPull(plan: PullPlan, resolutions: Record<string, Resolution> = {}, confirmation?: Confirmation): Promise<ApplyPullResult> {
    return this.exclusive(async () => {
      const stored = this.plans.get(plan.id);
      let state: MobileState;
      if (stored?.repair) {
        if (!this.store.prepareRepair || !this.store.repair || await this.store.prepareRepair(this.repository, this.branch) !== stored.repair) throw new Error('待修复记录已变化，请重新检查。');
        state = { version: 1, repository: this.repository, branch: this.branch, head: '', baseline: {} };
      } else state = await this.state();
      this.ready(state);
      if (!stored || state.head !== stored.baseHead || !sameSnapshot(state.baseline, stored.base)) throw new Error('下载审阅已失效，请重新检查。');
      if (state.pending) throw new Error('请先核对上次上传。');
      for (const change of stored.plan.changes) if (change.kind === 'conflict' && !['local', 'remote', 'both'].includes(resolutions[change.path] ?? '')) throw new Error('存在冲突（conflict），请逐个选择本地、远端或两者。');
      const local = await this.scan();
      checkPaths([...new Set([...local.paths, ...stored.remote.paths])], [...new Set([...local.directories, ...stored.remote.directories])]);
      if (stored.plan.initial && !stored.plan.attach && local.visible.length || local.blocked.some(change => allowedPath(change.path)) || !sameSnapshot(local.files, stored.local)) throw new Error('本地文件已变化，请重新检查。');
      if (await this.client.head() !== stored.remote.head) throw new Error('远端已变化，请重新检查。');
      const entries: ApplyEntry[] = [];
      const existing = new Set([...local.paths, ...local.directories, ...stored.remote.paths, ...stored.remote.directories]);
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
      checkPaths([...new Set([...paths, ...stored.remote.paths, ...entries.map(entry => entry.path)])], [...new Set([...directories, ...stored.remote.directories])]);
      if (stored.plan.initial && !stored.plan.attach && paths.some(path => !path.split('/').some(part => part.startsWith('.')))) throw new Error('首次导入期间文库已变化，请重新检查。');
      state.journal = {
        head: stored.remote.head, baseline: stored.remote.files, entries,
        directories: stored.remote.directories.filter(allowedDirectory).sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
        inventory: { files: stored.remote.paths, directories: stored.remote.directories },
      };
      if (entries.length || state.head !== stored.remote.head || !sameSnapshot(state.baseline, stored.remote.files)) delete state.draft;
      if (stored.repair) await this.store.repair!(stored.repair, state);
      else await this.store.save(state);
      const result = await this.finishJournal(state);
      this.plans.clear();
      return { preserved: result.preserved };
    });
  }
  private async finishJournal(state: MobileState): Promise<{ pending: boolean; preserved: string[] }> {
    const journal = state.journal;
    if (!journal) return { pending: false, preserved: [] };
    const preserved: string[] = [];
    // Recovery must validate the current full namespace before creating even an
    // empty directory. New user files may have appeared since the journal save.
    const inventory = async () => {
      const current = await this.files.list();
      if (current.some(entry => !['file', 'directory'].includes(entry.kind))) throw new Error('本地文件类型无效或包含链接，请先检查恢复路径。');
      const paths = current.filter(entry => entry.kind === 'file').map(entry => entry.path);
      const directories = current.filter(entry => entry.kind === 'directory').map(entry => entry.path);
      checkPaths(paths, directories);
      checkPaths([...new Set([...paths, ...(journal.inventory?.files ?? []), ...journal.entries.map(entry => entry.path)])],
        [...new Set([...directories, ...(journal.inventory?.directories ?? []), ...(journal.directories ?? [])])]);
      return directories;
    };
    await inventory();
    const required = journal.directories ?? [];
    // mkdir checks exact destinations and parents through the host boundary.
    // Ensure every required directory even if it existed in the initial scan;
    // rescanning the whole vault for each directory is quadratic on mobile.
    for (const directory of required) await this.files.mkdir(directory);
    const verify = async () => {
      const current = new Set(await inventory());
      const missing = required.filter(directory => !current.has(directory));
      if (!missing.length) return;
      for (const directory of missing) await this.files.mkdir(directory);
      const checked = new Set(await inventory());
      const absent = required.find(directory => !checked.has(directory));
      if (absent) throw new Error(`目录 ${absent} 创建验证失败，请先恢复。`);
    };
    // Validate the complete namespace after directory creation and before the
    // first document write. A removed directory gets one bounded repair pass.
    await verify();
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
    await verify();
    if (journal.entries.length || state.head !== journal.head || !sameSnapshot(state.baseline, journal.baseline)) delete state.draft;
    state.head = journal.head; state.baseline = journal.baseline;
    delete state.journal;
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
    if (state.staged) {
      for (const path of Object.keys(pending.files)) delete state.staged.files[path];
      state.staged.review.changes = state.staged.review.changes.filter(change => !(change.path in pending.files));
      state.staged.review.head = pending.commit; state.staged.review.id = crypto.randomUUID();
      if (!state.staged.review.changes.length) delete state.staged;
    }
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
      if (draft.review.index !== undefined) throw new Error('请先将工作区选择暂存，再提交已暂存的快照。');
      if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择需要上传的文件。');
      if (!message.trim() || message.length > 1000 || message.includes('\0')) throw new Error('提交说明不能为空且最多 1000 个字符。');
      checkSecret(message);
      const snapshots: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
      let size = 0;
      for (const path of selected) {
        const change = draft.review.changes.find(change => change.path === path && change.allowed);
        if (!change) throw new Error('选择包含未审阅或不允许的文件。');
        if (draft !== state.staged) {
          const bytes = await this.read(path);
          if ((bytes === null ? deleted : await blobSha(bytes)) !== change.digest) throw new Error('文件已变化，请重新检查。');
        }
        const snapshot = draft.files[path];
        if (snapshot === undefined || (snapshot === null ? deleted : await blobSha(fromBase64(snapshot))) !== change.digest) throw new Error('上传快照校验失败。');
        size += snapshot === null ? 0 : fromBase64(snapshot).length; budget(size);
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
      checkPaths([...proposed], remote.directories);
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
