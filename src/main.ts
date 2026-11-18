import { App, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TextFileView } from 'obsidian';
import { Repository, type Review, type PushReview } from './git.ts';
import { VaultPersistence } from './persistence.ts';
import { SyncPanel, SyncPlanModal, VIEW_TYPE, type PanelController } from './sync-view.ts';
import { Operations } from './operations.ts';

interface Settings { repository: string }

export default class WudaoGit extends Plugin {
  settings: Settings = { repository: '' };
  private engine?: Repository;
  private status?: HTMLElement;
  private persistence?:VaultPersistence; private disposed=false;private working=false;
  private remote?:{head:string;checkedAt:string};
  private operations=new Operations();
  private windows=new Set<()=>void>();

  async onload(): Promise<void> {
    const stored: unknown = await this.storage().loadSettings(await this.loadData());
    if(this.disposed)return;
    if (stored && typeof stored === 'object' && 'repository' in stored && typeof stored.repository === 'string') {
      this.settings.repository = stored.repository;
    }
    this.status = this.addStatusBarItem();
    this.status.setText('Git：手动同步');
    this.addSettingTab(new GitSettings(this.app, this));
    this.registerView(VIEW_TYPE,leaf=>new SyncPanel(leaf,this.controller()));
    this.addRibbonIcon('git-branch', '打开版本控制', () => { void this.openPanel(); });
    this.addCommand({id:'source-control',name:'打开版本控制',callback:()=>{void this.openPanel();}});
    this.addCommand({id:'check-remote',name:'检查远端并比较',callback:()=>{void this.perform(()=>this.check());}});
    this.addCommand({id:'attach',name:'连接现有文库',callback:()=>{void this.perform(()=>this.check(true));}});
    this.addCommand({id:'recover',name:'恢复中断同步',callback:()=>{void this.perform(async()=>{await this.repository().recover();new Notice('本地同步恢复已完成。');});}});
    this.addCommand({ id: 'review-changes', name: '检查并提交选中文件', callback: () => { void this.showChanges(); } });
    this.addCommand({ id: 'review-push', name: '检查并推送本地提交', callback: () => { void this.showPush(); } });
    this.addCommand({ id: 'pull', name: '拉取更新（仅快进）', callback: () => {
      void this.perform(async () => { await this.repository().pull(); new Notice('文库已更新。'); });
    } });
  }

  onunload():void{this.disposed=true;this.engine?.dispose();for(const close of [...this.windows])close();this.windows.clear();this.app.workspace.detachLeavesOfType?.(VIEW_TYPE);}
  trackWindow(close:()=>void):()=>void{if(this.disposed)throw new Error('插件已停用。');this.windows.add(close);return ()=>{this.windows.delete(close);};}
  storage():VaultPersistence{
    this.persistence??=new VaultPersistence(this.app.vault.adapter,this.app.vault.configDir,this.manifest.dir??`${this.app.vault.configDir}/plugins/${this.manifest.id}`);return this.persistence;
  }

  repository(): Repository {
    if(this.disposed)throw new Error('插件已停用。');
    if (process.platform !== 'darwin') throw new Error('当前版本支持 macOS，需要 /usr/bin/git 和 macOS 钥匙串。');
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('请使用本地磁盘上的文库。');
    this.engine ??= new Repository(adapter.getBasePath(), this.settings.repository);
    return this.engine;
  }

  async configure(repository: string): Promise<void> {
    const value = repository.trim();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('请使用本地文库。');
    const engine = new Repository(adapter.getBasePath(), value);
    // Validate the binding before saving it. This only reads local Git state.
    if(await engine.initialized())await engine.review();
    await this.storage().saveSettings({ repository: value });
    this.settings.repository = value;
    this.engine = engine;
  }

  async perform(action: () => Promise<void>): Promise<void> {
    if(this.disposed)return;if(this.working){new Notice('已有操作正在进行。');return;}this.working=true;
    this.status?.setText('Git：处理中');
    try {await this.operations.call(async()=>{ const views:TextFileView[]=[];this.app.workspace.iterateAllLeaves(leaf=>{if(leaf.view instanceof TextFileView)views.push(leaf.view);});
      for(const view of views){if(this.disposed)throw new Error('插件已停用。');await view.save();}if(this.disposed)throw new Error('插件已停用。');
      await action(); this.status?.setText('Git：手动同步');}); }
    catch (error) {
      this.status?.setText('Git：操作未完成');
      new Notice(error instanceof Error ? error.message : '操作未完成，请检查仓库和网络。', 12_000);
    }
    finally{this.working=false;if(!this.disposed)for(const leaf of this.app.workspace.getLeavesOfType?.(VIEW_TYPE)??[])if(leaf.view instanceof SyncPanel)void leaf.view.refresh();}
  }

  async showChanges(): Promise<void> {
    await this.perform(async () => {
      const repository = this.repository();
      new ChangesModal(this.app, this, repository, await repository.review()).open();
    });
  }

  async showPush(): Promise<void> {
    await this.perform(()=>this.openPush());
  }
  async openPush():Promise<void>{
      const repository = this.repository();
      const review = await repository.reviewPush();
      if (!review.commits.length) { new Notice('本地提交与远端一致，无需推送。'); return; }
      new PushModal(this.app, this, repository, review).open();
  }

  async openPanel():Promise<void>{
    if(this.disposed)return;let leaf=this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW_TYPE,active:true});}
    if(!this.disposed)await this.app.workspace.revealLeaf(leaf);
  }
  async check(attach=false):Promise<void>{
    const engine=this.repository();const initial=attach||!await engine.initialized();const plan=initial?await engine.planAttach():await engine.planPull();
    if(this.disposed||this.repository()!==engine)return;
    this.remote={head:plan.head,checkedAt:new Date().toLocaleString()};
    new SyncPlanModal(this.controller(),plan,{cancel:()=>engine.discardPlan(plan.id),previewPull:(p,path)=>engine.previewPull(p,path),apply:async(p,choices,approval)=>{
      if(this.disposed||this.repository()!==engine)throw new Error('设置已变化，请重新检查。');return engine.applyPull(p,choices,approval);
    }}).open();
  }
  private controller():PanelController{
    let working:Review|undefined;let staged:Review|undefined;
    return {app:this.app,mobile:false,active:()=>!this.disposed,trackWindow:close=>this.trackWindow(close),run:action=>this.perform(action),
      inspect:()=>this.operations.call(async()=>{const engine=this.repository();const initialized=await engine.initialized();
        if(!initialized)return {repository:this.settings.repository,branch:'main',head:'',initialized:false,recovery:false,changes:[],staged:[]};
        working=await engine.review();staged=await engine.reviewStaged();return {repository:this.settings.repository,branch:working.branch,head:working.head,initialized:true,recovery:await engine.recovery(),remote:this.remote,
          changes:working.changes.filter(f=>f.status==='??'||f.status[1]!==' '),staged:staged.changes,active:this.app.workspace.getActiveFile?.()?.path};}),
      stage:async paths=>{if(!working)throw new Error('请先刷新状态。');await this.repository().stage(working,paths);},
      unstage:paths=>this.repository().unstage(paths),preview:async(path,isStaged)=>{const review=isStaged?staged:working;if(!review)throw new Error('请先刷新状态。');return this.repository().preview(review,path);},
      commit:async(message,sync,paths)=>{if(!staged?.changes.length)throw new Error('请先暂存需要提交的文件。');
        const hash=await this.repository().commit(staged,paths?.length?paths:staged.changes.filter(f=>f.allowed).map(f=>f.path),message);
        new Notice('本地提交已完成：'+hash.slice(0,8));if(sync){
          const engine=this.repository();const plan=await engine.planPull();
          if(plan.integration||plan.changes.some(c=>c.kind==='remote'||c.kind==='conflict')||plan.directories.length){
            this.remote={head:plan.head,checkedAt:new Date().toLocaleString()};
            new SyncPlanModal(this.controller(),plan,{cancel:()=>engine.discardPlan(plan.id),previewPull:(p,path)=>engine.previewPull(p,path),apply:async(p,choices,approval)=>{
              if(this.disposed||this.repository()!==engine)throw new Error('设置已变化，请重新检查。');return engine.applyPull(p,choices,approval);
            }},()=>this.openPush()).open();
          }else await this.openPush();
        }},
      check:attach=>this.check(attach),recover:async()=>{const result=await this.repository().recover();new Notice(result.preserved.length?'已保留后续编辑，请检查。':'本地恢复已完成。');},
      history:()=>this.repository().history(),historyFiles:hash=>this.repository().historyFiles(hash),historyPreview:(hash,path)=>this.repository().historyPreview(hash,path)};
  }
}

class ChangesModal extends Modal {
  private plugin: WudaoGit;
  private repository: Repository;
  private review: Review;
  private selected = new Set<string>();
  private closed = false;

  constructor(app: App, plugin: WudaoGit, repository: Repository, review: Review) {
    super(app); this.plugin = plugin; this.repository = repository; this.review = review;
  }

  onOpen(): void {
    this.contentEl.addClass('wudao-git');
    this.setTitle('检查并提交文档');
    this.contentEl.createEl('p', { text: `${this.repository.repository} · ${this.review.branch}` });
    this.contentEl.createEl('p', { text: '勾选本次要提交的文件。提交保存在本地，上传前还会展示待推送提交。' });
    if (!this.review.changes.length) this.contentEl.createEl('p', { text: '目前没有未提交的改动。' });
    const list = this.contentEl.createDiv({ cls: 'wudao-git-list' });
    const preview = this.contentEl.createEl('pre', { cls: 'wudao-git-preview', text: '点击“查看”检查文件内容。' });
    for (const change of this.review.changes) {
      const row = list.createDiv({ cls: 'wudao-git-row' });
      const label = row.createEl('label');
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.disabled = !change.allowed;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(change.path); else this.selected.delete(change.path);
      });
      label.createSpan({ text: `${change.status.includes('D') ? '删除' : change.status === '??' ? '新增' : '修改'} · ${change.path}` });
      if (!change.allowed) { row.createEl('small', { text: change.reason }); continue; }
      const button = row.createEl('button', { text: '查看' });
      button.addEventListener('click', () => {
        void this.plugin.perform(async () => {
          const text = await this.repository.preview(this.review, change.path);
          if (!this.closed) preview.setText(text);
        });
      });
    }
    const message = this.contentEl.createEl('input', { type: 'text', placeholder: '本次提交说明，例如：补充行业调研结论' });
    message.addClass('wudao-git-message');
    message.maxLength = 1000;
    const buttons = this.contentEl.createDiv({ cls: 'wudao-git-actions' });
    const commit = buttons.createEl('button', { text: '提交选中文件', cls: 'mod-cta' });
    commit.addEventListener('click', () => {
      commit.disabled = true;
      void this.plugin.perform(async () => {
        const hash = await this.repository.commit(this.review, [...this.selected], message.value);
        new Notice(`本地提交已完成：${hash.slice(0, 8)}。使用“检查并推送本地提交”上传。`);
        this.close();
        await this.plugin.openPush();
      }).finally(() => { if (!this.closed) commit.disabled = false; });
    });
    buttons.createEl('button', { text: '关闭' }).addEventListener('click', () => { this.close(); });
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

class PushModal extends Modal {
  private plugin: WudaoGit;
  private repository: Repository;
  private review: PushReview;

  constructor(app: App, plugin: WudaoGit, repository: Repository, review: PushReview) {
    super(app); this.plugin = plugin; this.repository = repository; this.review = review;
  }

  onOpen(): void {
    this.contentEl.addClass('wudao-git');
    this.setTitle('确认上传到 GitHub');
    this.contentEl.createEl('p', { text: `目标：${this.repository.repository} · ${this.review.branch}` });
    this.contentEl.createEl('p', { text: `共 ${this.review.commits.length} 个提交。请核对以下提交和文件；上传后删除文件仍可能保留历史版本。` });
    const list = this.contentEl.createDiv({ cls: 'wudao-git-list' });
    for (const commit of this.review.commits) {
      const section = list.createEl('section');
      section.createEl('h3', { text: `${commit.hash.slice(0, 8)} · ${commit.subject}` });
      const files = section.createEl('ul');
      for (const file of commit.files) files.createEl('li', { text: file });
    }
    const buttons = this.contentEl.createDiv({ cls: 'wudao-git-actions' });
    const push = buttons.createEl('button', { text: '推送这些提交', cls: 'mod-cta' });
    push.addEventListener('click', () => {
      push.disabled = true;
      void this.plugin.perform(async () => {
        const result = await this.repository.push(this.review);
        new Notice(result.trackingUpdated ? '所审阅的提交已上传到 GitHub。' : 'GitHub 已确认上传，本地追踪状态未刷新；请稍后检查更新或使用 Git fetch 刷新。', 10000);
        this.close();
      }).finally(() => { push.disabled = false; });
    });
    buttons.createEl('button', { text: '取消' }).addEventListener('click', () => { this.close(); });
  }

  onClose(): void { this.contentEl.empty(); }
}

class GitSettings extends PluginSettingTab {
  private plugin: WudaoGit;
  constructor(app: App, plugin: WudaoGit) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Wudao Git' });
    this.containerEl.createEl('p', { text: `当前版本：${this.plugin.manifest.version}。文章修改需先提交，再确认推送到 GitHub。` });
    this.containerEl.createEl('p', { text: '仅手动同步到绑定的 GitHub 仓库。认证由本机 Git 和 macOS 钥匙串处理。' });
    this.containerEl.createEl('p',{text:'升级延续原 .git、暂存内容与未提交编辑。仓库设置独立保存在文库配置目录的 wudao-git/ 中。'});
    new Setting(this.containerEl).addButton(button=>{button.setButtonText('打开版本控制').onClick(()=>{void this.plugin.openPanel();});});
    let repository = this.plugin.settings.repository;
    new Setting(this.containerEl)
      .setName('GitHub 仓库')
      .setDesc('填写 owner/repository，并确保文库 Git 的 origin 使用同一仓库的 HTTPS 地址。')
      .addText(text => { text.setPlaceholder('owner/repository').setValue(repository).onChange(value => { repository = value; }); })
      .addButton(button => { button.setButtonText('验证并保存').onClick(() => {
        void this.plugin.perform(async () => { await this.plugin.configure(repository); new Notice('仓库绑定已保存。'); });
      }); });
    this.containerEl.createEl('p', { text: '首次使用前，请先在文库根目录初始化 Git、设置本地提交作者，并完成首次推送。不要同时启用其他 Git 同步插件。' });
  }
}
