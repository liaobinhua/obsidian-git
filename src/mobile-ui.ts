import { App, Modal, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type WudaoMobile from './mobile-main.ts';
import type { MobileSettings } from './mobile-main.ts';
import type { MobileEngine, MobileReview, PullPlan, Resolution, Confirmation } from './mobile/index.ts';
import { appliedSummary, pullSummary } from './mobile-presentation.ts';

function confirmation(container: HTMLElement, paths: string[]): () => Confirmation {
  const approved = new Set<string>(); let bulkDelete = false;
  for (const path of paths) {
    const label = container.createEl('label', { cls: 'wudao-git-check' });
    const box = label.createEl('input', { type: 'checkbox' }); label.createSpan({ text: `确认删除：${path}` });
    box.addEventListener('change', () => { if (box.checked) approved.add(path); else approved.delete(path); });
  }
  if (paths.length >= 2) {
    const label = container.createEl('label', { cls: 'wudao-git-check' });
    const box = label.createEl('input', { type: 'checkbox' }); label.createSpan({ text: '我已检查并确认本次批量删除。' });
    box.addEventListener('change', () => { bulkDelete = box.checked; });
  }
  return () => ({ deletions: [...approved], bulkDelete });
}

abstract class ReviewModal extends Modal {
  protected plugin: WudaoMobile; protected engine: MobileEngine; protected closed = false;
  private untrack: () => void;
  constructor(app: App, plugin: WudaoMobile, engine: MobileEngine) {
    super(app); this.plugin = plugin; this.engine = engine;
    this.untrack = plugin.trackWindow(() => { this.close(); });
  }
  protected actions(text: string, action: () => Promise<void>, enabled = true): void {
    const row = this.contentEl.createDiv({ cls: 'wudao-git-actions' });
    const primary = row.createEl('button', { text, cls: 'mod-cta' });
    primary.disabled = !enabled;
    const cancel = row.createEl('button', { text: '关闭' }); cancel.addEventListener('click', () => { this.close(); });
    primary.addEventListener('click', () => {
      primary.disabled = true; cancel.disabled = true;
      void this.plugin.run(async () => { this.plugin.assertEngine(this.engine); await action(); })
        .finally(() => { if (!this.closed) { primary.disabled = !enabled; cancel.disabled = false; } });
    });
  }
  protected caption(): void { this.contentEl.addClass('wudao-git'); this.contentEl.createEl('p', { text: `${this.plugin.settings.repository} · ${this.plugin.settings.branch}` }); }
  onClose(): void { this.closed = true; this.untrack(); this.contentEl.empty(); }
}

export class ChangesModal extends ReviewModal {
  private review: MobileReview;
  constructor(app: App, plugin: WudaoMobile, engine: MobileEngine, review: MobileReview) { super(app, plugin, engine); this.review = review; }
  onOpen(): void {
    this.setTitle('检查手机文库改动'); this.caption();
    if (!this.plugin.settings.uploadEnabled) this.contentEl.createEl('p', { text: '当前为仅下载模式，可以离线审阅。需要上传时，请在设置中开启“允许上传”并保存，然后重新检查文件。' });
    this.contentEl.createEl('p', { text: '此步骤可以离线检查。勾选文件后还需确认上传，才会修改 GitHub。' });
    const selected = new Set<string>();
    const list = this.contentEl.createDiv({ cls: 'wudao-git-list' });
    const preview = this.contentEl.createEl('pre', { cls: 'wudao-git-preview', text: '点击“查看”检查当前快照。' });
    if (!this.review.changes.length) list.createEl('p', { text: '没有需要上传的改动。' });
    for (const change of this.review.changes) {
      const row = list.createDiv({ cls: 'wudao-git-row' }); const label = row.createEl('label');
      const box = label.createEl('input', { type: 'checkbox' }); box.disabled = !change.allowed;
      label.createSpan({ text: `${({ add: '新增', modify: '修改', delete: '删除' })[change.status]} · ${change.path}` });
      box.addEventListener('change', () => { if (box.checked) selected.add(change.path); else selected.delete(change.path); });
      if (!change.allowed) { row.createEl('small', { text: change.reason }); continue; }
      row.createEl('button', { text: '查看', attr: { 'aria-label': `查看 ${change.path}` } }).addEventListener('click', () => {
        void this.plugin.run(async () => { this.plugin.assertEngine(this.engine); const text = await this.engine.preview(this.review, change.path); if (!this.closed) preview.setText(text); });
      });
    }
    const message = this.contentEl.createEl('input', { type: 'text', placeholder: '填写本次上传说明', attr: { 'aria-label': '上传说明' } });
    message.maxLength = 1000; message.addClass('wudao-git-message');
    this.actions('核对本次上传', async () => {
      if (!selected.size || !message.value.trim()) throw new Error('请选择文件并填写说明。');
      new UploadModal(this.app, this.plugin, this.engine, this.review, [...selected], message.value).open(); this.close();
    });
  }
}

export class UploadModal extends ReviewModal {
  private review: MobileReview; private selected: string[]; private message: string; private retry: boolean;
  constructor(app: App, plugin: WudaoMobile, engine: MobileEngine, review: MobileReview, selected: string[], message: string, retry = false) {
    super(app, plugin, engine); this.review = review; this.selected = selected; this.message = message; this.retry = retry;
  }
  onOpen(): void {
    this.setTitle(this.retry ? '核对并重试原提交' : '确认上传到 GitHub'); this.caption();
    if (!this.plugin.settings.uploadEnabled) this.contentEl.createEl('p', { text: '上传已关闭。请先在设置中开启“允许上传”并保存，再重新打开审阅窗口。' });
    this.contentEl.createEl('p', { text: this.message });
    if (this.retry) this.contentEl.createEl('p', { text: '重试的是先前创建的同一提交，不会混入手机后续编辑。后续编辑仍会保留在本地。' });
    const list = this.contentEl.createEl('ul'); for (const path of this.selected) list.createEl('li', { text: path });
    const paths = this.review.changes.filter(c => this.selected.includes(c.path) && c.status === 'delete').map(c => c.path);
    const approval = confirmation(this.contentEl, paths);
    this.contentEl.createEl('p', { text: '上传成功以远端确认结果为准。普通删除不会清除 Git 历史。' });
    this.actions(this.plugin.settings.uploadEnabled ? '确认上传' : '仅下载模式，上传已关闭', async () => {
      if (!this.plugin.settings.uploadEnabled) throw new Error('当前为仅下载模式，请先在插件设置中启用上传。');
      const hash = await this.engine.upload(this.review, this.selected, this.message, approval());
      new Notice(`GitHub 已确认上传：${hash.slice(0, 8)}`); this.close();
    }, this.plugin.settings.uploadEnabled);
  }
}

export class DownloadModal extends ReviewModal {
  private plan: PullPlan;
  constructor(app: App, plugin: WudaoMobile, engine: MobileEngine, plan: PullPlan) { super(app, plugin, engine); this.plan = plan; }
  onOpen(): void {
    this.setTitle(this.plan.initial ? '确认首次下载' : '检查远端更新与冲突'); this.caption();
    this.contentEl.createEl('p', { text: pullSummary(this.plan) });
    this.contentEl.createEl('p', { text: `本次核对到 GitHub 提交 ${this.plan.head.slice(0, 8)}。` });
    this.contentEl.createEl('p', { text: '先检查变化。冲突必须逐项选择；保留两份会将手机原文保存为 local-copy 文件。' });
    const resolutions: Record<string, Resolution> = Object.create(null) as Record<string, Resolution>;
    const list = this.contentEl.createDiv({ cls: 'wudao-git-list' });
    const preview = this.contentEl.createEl('pre', { cls: 'wudao-git-preview', text: '点击“查看”比较基线、本地和远端。' });
    if (!this.plan.changes.length && !this.plan.directories.length) list.createEl('p', { text: '文档内容与目录结构一致，没有待应用更新。' });
    for (const path of this.plan.directories) list.createEl('p', { text: `待创建目录 · ${path}` });
    for (const change of this.plan.changes) {
      const row = list.createDiv({ cls: 'wudao-git-row' });
      row.createSpan({ text: `${({ remote: '远端更新', local: '保留本地待上传', conflict: '冲突', same: '两端一致' })[change.kind]} · ${change.path}` });
      if (change.kind === 'conflict') {
        const select = row.createEl('select', { attr: { 'aria-label': `${change.path} 的冲突处理方式` } });
        for (const [value, text] of [['', '请选择处理方式'], ['both', '保留两份'], ['local', '保留手机版本'], ['remote', '采用远端版本']] as const) select.createEl('option', { value, text });
        select.addEventListener('change', () => { if (select.value) resolutions[change.path] = select.value as Resolution; else delete resolutions[change.path]; });
      }
      row.createEl('button', { text: '查看', attr: { 'aria-label': `比较 ${change.path}` } }).addEventListener('click', () => {
        void this.plugin.run(async () => { this.plugin.assertEngine(this.engine); const text = await this.engine.previewPull(this.plan, change.path); if (!this.closed) preview.setText(text); });
      });
    }
    if (this.plan.deletions.length) this.contentEl.createEl('p', { text: '远端删除需逐项确认。冲突选择“保留手机版本”时，该原文不会删除。' });
    if (this.plan.summary.excluded.length) {
      const excluded = this.contentEl.createEl('details');
      excluded.createEl('summary', { text: `查看 ${this.plan.summary.excluded.length} 个主动排除文件及原因` });
      const entries = excluded.createEl('ul');
      for (const entry of this.plan.summary.excluded) entries.createEl('li', { text: `${entry.path}：${entry.reason}` });
    }
    const approval = confirmation(this.contentEl, this.plan.deletions);
    this.actions('应用已检查的更新', async () => {
      const choices = { ...resolutions };
      const approved = approval();
      const effective = this.plan.deletions.filter(path => choices[path] !== 'local');
      const result = await this.engine.applyPull(this.plan, choices, { deletions: approved.deletions.filter(path => effective.includes(path)), bulkDelete: approved.bulkDelete });
      new Notice(appliedSummary(this.plan, choices, result.preserved), 14000); this.close();
    });
  }
}

export class MobileSettingsTab extends PluginSettingTab {
  private plugin: WudaoMobile;
  constructor(app: App, plugin: WudaoMobile) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    this.containerEl.empty(); this.containerEl.createEl('h2', { text: 'Wudao Git · Android' });
    this.containerEl.createEl('p', { text: `当前版本：${this.plugin.manifest.version}。${this.plugin.modeLabel()}。` });
    this.containerEl.createEl('a', { text: '查看插件安装包与升级说明', href: 'https://github.com/liaobinhua/obsidian-git/releases', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    this.containerEl.createEl('p', { text: '已有文章可原位连接并比较。手机使用本机专用令牌引用，不共享电脑钥匙串。配置与同步记录独立保存在文库配置目录的 wudao-git/ 中。' });
    const next: MobileSettings = { ...this.plugin.settings };
    new Setting(this.containerEl).setName('GitHub 仓库').setDesc('填写文章仓库的 owner/repository；它与下载插件的源码仓库可以不同。').addText(text => { text.setValue(next.repository).setPlaceholder('owner/repository').onChange(value => { next.repository = value; }); });
    new Setting(this.containerEl).setName('分支').addText(text => { text.setValue(next.branch).onChange(value => { next.branch = value; }); });
    new Setting(this.containerEl).setName('手机专用令牌').setDesc('仅在本机 SecretStorage 中保存。插件配置只保存引用名称。')
      .addComponent(element => new SecretComponent(this.app, element).setValue(next.secretName).onChange(value => { next.secretName = value ?? ''; }));
    new Setting(this.containerEl).setName('允许上传').setDesc('默认关闭。首次下载并检查内容后，再启用手机上传。').addToggle(toggle => { toggle.setValue(next.uploadEnabled).onChange(value => { next.uploadEnabled = value; }); });
    new Setting(this.containerEl).addButton(button => { button.setButtonText('保存设置').setCta().onClick(() => { void this.plugin.configure(next); }); });
    new Setting(this.containerEl).addButton(button => { button.setButtonText('保存并检查远端更新').onClick(async () => { if (await this.plugin.configure(next)) await this.plugin.showPull(); }); });
    new Setting(this.containerEl).addButton(button=>{button.setButtonText('打开版本控制').onClick(()=>{void this.plugin.openPanel();});});
    this.containerEl.createEl('p', { text: '正常升级会延续原同步关系。记录缺失时使用“连接现有文库”，记录损坏时使用“修复同步记录并重新比较”。已有记录的仓库或分支变更仍需单独核对。' });
  }
}
