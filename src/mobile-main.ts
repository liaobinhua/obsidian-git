import { Notice, Platform, Plugin, TextFileView, TFile } from 'obsidian';
import { GitHubClient, MobileEngine } from './mobile/index.ts';
import { binding } from './mobile/policy.ts';
import { MobileFiles, RotatingStateStore, createRequest, restrictedRequest } from './mobile-host.ts';
import { ChangesModal, DownloadModal, MobileSettingsTab, UploadModal } from './mobile-ui.ts';

export interface MobileSettings { repository: string; branch: string; secretName: string; uploadEnabled: boolean }

export default class WudaoMobile extends Plugin {
  settings: MobileSettings = { repository: '', branch: 'main', secretName: '', uploadEnabled: false };
  private engine?: MobileEngine;
  private working = false;
  private disposed = false;
  private lifetime = new AbortController();
  private windows = new Set<() => void>();
  private status?: HTMLElement;

  async onload(): Promise<void> {
    if (!Platform.isAndroidApp) throw new Error('这是 Android 安装包，请在 Mac 上使用 macOS 安装包。');
    const data: unknown = await this.loadData();
    if (this.disposed) return;
    if (data && typeof data === 'object') {
      const stored = data as Record<string, unknown>;
      for (const key of ['repository', 'branch', 'secretName'] as const) {
        if (typeof stored[key] === 'string') this.settings[key] = stored[key];
      }
      if ('uploadEnabled' in data && typeof data.uploadEnabled === 'boolean') this.settings.uploadEnabled = data.uploadEnabled;
    }
    this.status = this.addStatusBarItem(); this.status.setText('Git：手机手动同步');
    this.addSettingTab(new MobileSettingsTab(this.app, this));
    this.addRibbonIcon('git-branch', '检查手机文库改动', () => { void this.showChanges(); });
    this.addCommand({ id: 'download', name: '首次下载或检查远端更新', callback: () => { void this.showPull(); } });
    this.addCommand({ id: 'review-changes', name: '检查并上传选中文件', callback: () => { void this.showChanges(); } });
    this.addCommand({ id: 'recover', name: '恢复或核对中断的同步', callback: () => { void this.recover(); } });
    try {
      const state = await this.store().load();
      if (this.disposed) return;
      if (state?.journal || state?.pending) new Notice('上次同步尚未完成，请运行“恢复或核对中断的同步”。', 10000);
    } catch { new Notice('本地同步记录无法读取。请保留文档和状态备份，再检查恢复说明。', 12000); }
  }

  onunload(): void {
    this.disposed = true; this.lifetime.abort();
    for (const close of [...this.windows]) close();
    this.windows.clear();
  }

  trackWindow(close: () => void): () => void {
    if (this.disposed) throw new Error('插件已停用，请重新打开检查窗口。');
    this.windows.add(close); return () => { this.windows.delete(close); };
  }

  store(): RotatingStateStore {
    return new RotatingStateStore(this.app.vault.adapter, this.manifest.dir ?? `${this.app.vault.configDir}/${this.manifest.id}`);
  }

  private secret(): string {
    if (!this.settings.secretName || !this.app.secretStorage) throw new Error('请在插件设置中选择手机专用 GitHub 令牌。');
    const value = this.app.secretStorage.getSecret(this.settings.secretName);
    if (!value) throw new Error('找不到手机专用令牌，请重新选择或添加。');
    return value;
  }

  repository(): MobileEngine {
    if (this.disposed) throw new Error('插件已停用。');
    if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID) throw new Error('请更新 Android System WebView 和 Obsidian 后重试。');
    if (!this.engine) {
      binding(this.settings.repository, this.settings.branch);
      const transport = createRequest(globalThis.fetch, this.lifetime.signal);
      const client = new GitHubClient({
        repository: this.settings.repository, branch: this.settings.branch,
        token: async () => this.secret(),
        request: restrictedRequest(transport, () => this.settings.uploadEnabled),
      });
      const vault = this.app.vault;
      const files = new MobileFiles(vault.adapter, {
        mkdir: async path => {
          if (this.disposed) throw new Error('插件已停用，本地写入日志已保留。');
          await vault.createFolder(path);
        },
        write: async (path, bytes) => {
          if (this.disposed) throw new Error('插件已停用，本地写入日志已保留。');
          const file = vault.getAbstractFileByPath(path);
          if (file && !(file instanceof TFile)) throw new Error('目标路径不是文章或附件。');
          if (file instanceof TFile) await vault.modifyBinary(file, Uint8Array.from(bytes).buffer);
          else await vault.createBinary(path, Uint8Array.from(bytes).buffer);
        },
        remove: async path => {
          if (this.disposed) throw new Error('插件已停用，本地写入日志已保留。');
          const file = vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw new Error('删除目标尚未被 Obsidian 识别，请重新打开文库后重试。');
          await vault.trash(file, false);
        },
      });
      this.engine = new MobileEngine({ repository: this.settings.repository, branch: this.settings.branch, client, files, store: this.store() });
    }
    return this.engine;
  }

  assertEngine(engine: MobileEngine): void {
    if (this.disposed || this.repository() !== engine) throw new Error('插件设置已变化，请关闭窗口并重新检查。');
  }

  async configure(settings: MobileSettings): Promise<void> {
    await this.run(async () => {
      const next = { ...settings, repository: settings.repository.trim(), branch: settings.branch.trim() };
      binding(next.repository, next.branch);
      const state = await this.store().load();
      if (this.disposed) throw new Error('插件已停用，设置未保存。');
      if (state && (state.repository !== next.repository || state.branch !== next.branch)) throw new Error('此文库已有同步记录。连接其他仓库或分支时，请新建空白文库。');
      this.settings = next; await this.saveData(this.settings); this.engine = undefined;
      new Notice('设置已保存。首次使用请先检查远端并下载。');
    });
  }

  async run(action: () => Promise<void>): Promise<void> {
    if (this.disposed) { new Notice('插件已停用，请关闭窗口后重新启用。'); return; }
    if (this.working) { new Notice('已有操作正在进行，请等待完成。'); return; }
    this.working = true; this.status?.setText('Git：处理中');
    const progress = new Notice('正在处理同步，请保持 Obsidian 打开。', 0);
    try {
      const views: TextFileView[] = [];
      this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof TextFileView) views.push(leaf.view); });
      for (const view of views) {
        if (this.disposed) throw new Error('插件已停用，操作已停止。');
        await view.save();
      }
      if (this.disposed) throw new Error('插件已停用，操作已停止。');
      await action(); this.status?.setText('Git：手机手动同步');
    }
    catch (error) { this.status?.setText('Git：需要检查'); new Notice(error instanceof Error ? error.message : '同步未完成，本地内容已保留。', 14000); }
    finally { this.working = false; progress.hide(); }
  }

  async showPull(): Promise<void> {
    await this.run(async () => {
      this.secret(); const engine = this.repository(); const plan = await engine.planPull();
      this.assertEngine(engine); new DownloadModal(this.app, this, engine, plan).open();
    });
  }

  async showChanges(): Promise<void> {
    await this.run(async () => {
      const engine = this.repository(); const review = await engine.review();
      this.assertEngine(engine); new ChangesModal(this.app, this, engine, review).open();
    });
  }

  async recover(): Promise<void> {
    await this.run(async () => {
      const engine = this.repository(); const result = await engine.recover();
      this.assertEngine(engine);
      if (!result.pending) { new Notice(result.preserved.length ? `已保留以下文件的当前内容，请检查：${result.preserved.join('、')}。需要时从 GitHub 恢复完整版本。` : '恢复与远端核对已完成。', 12000); return; }
      const state = await this.store().load();
      this.assertEngine(engine);
      if (!state?.pending || !state.draft) throw new Error('待上传记录不完整，请保留状态备份并重新检查。');
      new UploadModal(this.app, this, engine, state.draft.review, Object.keys(state.pending.files), '重试原先已审阅的同一提交', true).open();
    });
  }
}
