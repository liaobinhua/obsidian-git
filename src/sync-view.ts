import { ItemView, Modal, Notice, WorkspaceLeaf } from 'obsidian';
import type { App } from 'obsidian';
import type { Confirmation, PullPlan, Resolution } from './mobile/types.ts';
import { allowedPath } from './mobile/policy.ts';
import { pullSummary, appliedSummary } from './mobile-presentation.ts';

export const VIEW_TYPE = 'wudao-git-source-control';
export interface PanelFile { path: string; status: string; allowed: boolean; reason: string; digest: string }
export interface PanelState { repository: string; branch: string; head: string; initialized: boolean; recovery: boolean; changes: PanelFile[]; staged: PanelFile[]; active?: string; remote?:{head:string;checkedAt:string} }
export interface PanelController {
  app: App; mobile: boolean; active(): boolean;
  trackWindow?(close:()=>void):()=>void;
  run(action: () => Promise<void>): Promise<void>;
  inspect(): Promise<PanelState>; stage(paths: string[]): Promise<void>; unstage(paths: string[]): Promise<void>;
  preview(path: string, staged: boolean, remote?:boolean): Promise<string>; commit(message: string, sync: boolean, paths?:string[]): Promise<void>;
  check(attach?: boolean, repair?: boolean): Promise<void>; recover(): Promise<void>;
  history(): Promise<{hash:string;subject:string;date:string}[]>;
  historyFiles(hash:string):Promise<{path:string;status:string}[]>;
  historyPreview(hash:string,path:string):Promise<string>;
}
const label = (file:PanelFile) => ({add:'新增',modify:'修改',delete:'删除',conflict:'冲突',A:'新增',M:'修改',D:'删除','??':'新增'}[file.status.trim()]??file.status.trim());

/** Both platforms share a view; mobile snapshots stay distinct from Git commits. */
export class SyncPanel extends ItemView {
  private controller: PanelController;
  private closed=false; private timer?: number; private rendering=false; private again=false; private busy=false;
  private previewText='点击文件的“查看差异”比较内容。';private message='';private selected=new Set<string>();private stagedSelected=new Set<string>();
  constructor(leaf:WorkspaceLeaf,controller:PanelController){super(leaf);this.controller=controller;}
  getViewType(){return VIEW_TYPE;} getDisplayText(){return 'Wudao Git · 版本控制';} getIcon(){return 'git-branch';}
  async onOpen():Promise<void>{
    const schedule=()=>{if(this.timer!==undefined)window.clearTimeout(this.timer);this.timer=window.setTimeout(()=>{void this.refresh();},400);};
    this.registerEvent(this.app.vault.on('create',schedule));this.registerEvent(this.app.vault.on('modify',schedule));
    this.registerEvent(this.app.vault.on('delete',schedule));this.registerEvent(this.app.vault.on('rename',schedule));
    this.registerEvent(this.app.workspace.on('file-open',schedule));await this.refresh();
  }
  async onClose():Promise<void>{this.closed=true;if(this.timer!==undefined)window.clearTimeout(this.timer);}
  private button(parent:HTMLElement,text:string,action:()=>Promise<void>){
    const button=parent.createEl('button',{text});button.disabled=this.busy;
    button.addEventListener('click',()=>{if(this.busy)return;this.busy=true;button.disabled=true;
      void this.controller.run(async()=>{if(!this.controller.active())throw new Error('插件已停用。');await action();})
        .finally(()=>{this.busy=false;if(!this.closed)void this.refresh();});});return button;
  }
  async refresh():Promise<void>{
    if(this.closed||!this.controller.active())return;if(this.rendering||this.busy){this.again=true;return;}
    this.rendering=true;this.again=false;
    try{
      const state=await this.controller.inspect();if(this.closed||!this.controller.active())return;
      const container=this.contentEl;container.empty();container.addClass('wudao-git');container.createEl('h3',{text:'版本控制'});
      container.createEl('p',{text:`${state.repository||'尚未设置仓库'} · ${state.branch||'main'} · 本地基线 ${state.head?state.head.slice(0,8):'尚未建立'}`});
      container.createEl('p',{text:'本页自动刷新本地文件状态。远端最新状态请点击“检查远端”；本地无变化不代表远端已核对。'});
      container.createEl('p',{text:state.remote?`上次检查远端：${state.remote.checkedAt} · ${state.remote.head.slice(0,8)}。之后的变化需再次检查。`:'本次启动后尚未核对远端。'});
      if(state.active){const working=state.changes.find(f=>f.path===state.active);const staged=state.staged.some(f=>f.path===state.active);
        container.createEl('p',{text:`当前文件：${state.active} · ${!allowedPath(state.active)?'不在同步范围':working?`${staged?'已暂存，另有工作区变化':'本地有变化'}`:staged?'已暂存':state.initialized?'没有本地差异':'尚未建立同步关系'}`});}
      const actions=container.createDiv({cls:'wudao-git-actions'});
      this.button(actions,'刷新本地',async()=>{});this.button(actions,'检查远端',()=>this.controller.check());
      if(!state.initialized)this.button(actions,'连接现有文库',()=>this.controller.check(true));
      this.button(actions,'提交历史',async()=>{new HistoryModal(this.controller,await this.controller.history()).open();});
      if(state.recovery)this.button(actions,'恢复中断同步',()=>this.controller.recover());
      if(!state.initialized)container.createEl('p',{text:'已有文章会原位保留。连接后先比较本地与远端，无需清空文库。'});
      const selected=this.selected;const stagedSelected=this.stagedSelected;
      for(const path of selected)if(!state.changes.some(f=>f.path===path))selected.delete(path);
      for(const path of stagedSelected)if(!state.staged.some(f=>f.path===path))stagedSelected.delete(path);
      const preview=container.createEl('pre',{cls:'wudao-git-preview',text:this.previewText});
      const section=(title:string,files:PanelFile[],set:Set<string>,staged:boolean)=>{
        container.createEl('h4',{text:`${title}（${files.length}）`});const list=container.createDiv({cls:'wudao-git-list'});
        for(const file of files){const row=list.createDiv({cls:'wudao-git-row'});const check=row.createEl('label');
          const box=check.createEl('input',{type:'checkbox',attr:{'aria-label':`选择${staged?'暂存快照':'工作区文件'} ${file.path}`}});box.disabled=!file.allowed;box.checked=set.has(file.path);
          box.addEventListener('change',()=>{if(box.checked)set.add(file.path);else set.delete(file.path);});check.createSpan({text:`${label(file)} · ${file.path}`});
          if(!file.allowed){row.createEl('small',{text:file.reason});continue;}
          this.button(row,'查看差异',async()=>{const text=await this.controller.preview(file.path,staged);if(!this.closed){this.previewText=text;preview.setText(text);}});
          if(this.controller.mobile)this.button(row,'联网补全基线',async()=>{const text=await this.controller.preview(file.path,staged,true);if(!this.closed){this.previewText=text;preview.setText(text);}});
        }
      };
      section('工作区变化',state.changes,selected,false);this.button(container,'暂存选中文件',()=>this.controller.stage([...selected]));
      section(this.controller.mobile?'已暂存的待上传快照':'已暂存',state.staged,stagedSelected,true);this.button(container,'取消暂存选中文件',()=>this.controller.unstage([...stagedSelected]));
      container.createEl('p',{text:this.controller.mobile?'手机离线暂存是待上传快照。联网确认上传后才形成 GitHub 提交；暂存后的新编辑继续保留。':'提交使用已暂存内容。未暂存编辑和未选中的暂存文件继续保留。'});
      const message=container.createEl('input',{type:'text',cls:'wudao-git-message',placeholder:'本次提交说明',attr:{'aria-label':'提交说明'}});message.maxLength=1000;
      message.value=this.message;message.addEventListener('input',()=>{this.message=message.value;});
      container.createEl('p',{text:'勾选暂存项时仅提交勾选项；未勾选时提交全部允许的暂存内容。'});
      this.button(container,'提交并同步',()=>this.controller.commit(message.value,true,[...stagedSelected]));
      if(!this.controller.mobile)this.button(container,'仅提交到本地',()=>this.controller.commit(message.value,false,[...stagedSelected]));
      if(!state.changes.length&&!state.staged.length)container.createEl('p',{text:'本地暂未发现待提交的文档变化。'});
    }catch(error){if(!this.closed){this.contentEl.empty();this.contentEl.createEl('p',{text:error instanceof Error?error.message:'状态无法读取。'});
      this.button(this.contentEl,'修复同步记录并重新比较',()=>this.controller.check(true,true));this.button(this.contentEl,'重新检查本地',async()=>{});}}
    finally{this.rendering=false;if(this.again){this.again=false;void this.refresh();}}
  }
}

interface PullPort { previewPull(plan:PullPlan,path:string):Promise<string>; apply(plan:PullPlan,choices:Record<string,Resolution>,approval:Confirmation):Promise<{preserved:string[]}>;cancel?():Promise<void> }
export class SyncPlanModal extends Modal {
  private host:PanelController;private plan:PullPlan;private port:PullPort;private closed=false;
  private after?:()=>Promise<void>;
  private untrack?:()=>void;
  constructor(host:PanelController,plan:PullPlan,port:PullPort,after?:()=>Promise<void>){super(host.app);this.host=host;this.plan=plan;this.port=port;this.after=after;this.untrack=host.trackWindow?.(()=>this.close());}
  onOpen():void{
    this.setTitle(this.plan.initial?'连接现有文库：比较并建立同步关系':'检查远端更新与冲突');this.contentEl.addClass('wudao-git');
    this.contentEl.createEl('p',{text:pullSummary(this.plan)});this.contentEl.createEl('p',{text:`本次远端提交：${this.plan.head.slice(0,8)}。此窗口只做预览，确认后才更新本地。`});
    if(this.plan.initial)this.contentEl.createEl('p',{text:'本地独有文章继续保留。没有历史基线，不会把缺少文件推断为删除。'});
    if(this.plan.integration)this.contentEl.createEl('p',{text:'本次还会快进或合并提交历史，保留双方历史；文件内容相同也需要更新 Git 基线。'});
    const choices:Record<string,Resolution>=Object.create(null);const deletions=new Set<string>();let bulk=false;
    const preview=this.contentEl.createEl('pre',{cls:'wudao-git-preview',text:'选择文件查看内容差异。'});
    const list=this.contentEl.createDiv({cls:'wudao-git-list'});
    for(const directory of this.plan.directories)list.createEl('p',{text:`待补齐目录 · ${directory}`});
    for(const change of this.plan.changes){const row=list.createDiv({cls:'wudao-git-row'});row.createSpan({text:`${({local:'保留本地',remote:'远端变化',same:'两端相同',conflict:'需要处理冲突'})[change.kind]} · ${change.path}`});
      if(change.kind==='conflict'){const select=row.createEl('select', {attr:{'aria-label':`冲突处理 ${change.path}`}});
        for(const [value,text] of [['','请选择'],['local','保留本地'],['remote','采用远端'],['both','保留两份']])select.createEl('option',{text, value});
        select.addEventListener('change',()=>{if(select.value)choices[change.path]=select.value as Resolution;else delete choices[change.path];});}
      row.createEl('button',{text:'查看'}).addEventListener('click',()=>{void this.host.run(async()=>{const text=await this.port.previewPull(this.plan,change.path);if(!this.closed)preview.setText(text);});});
    }
    if(this.plan.summary.excluded.length){const detail=this.contentEl.createEl('details');detail.createEl('summary',{text:`主动排除 ${this.plan.summary.excluded.length} 个文件`});for(const file of this.plan.summary.excluded)detail.createEl('p',{text:`${file.path}：${file.reason}`});}
    for(const path of this.plan.deletions){const label=this.contentEl.createEl('label',{cls:'wudao-git-check'});const box=label.createEl('input',{type:'checkbox'});label.createSpan({text:'确认删除：'+path});box.addEventListener('change',()=>{if(box.checked)deletions.add(path);else deletions.delete(path);});}
    if(this.plan.deletions.length>=2){const label=this.contentEl.createEl('label',{cls:'wudao-git-check'});const box=label.createEl('input',{type:'checkbox'});label.createSpan({text:'确认本次批量删除'});box.addEventListener('change',()=>{bulk=box.checked;});}
    const button=this.contentEl.createEl('button',{text:this.plan.initial?'确认连接并保留本地文章':'应用已检查的更新',cls:'mod-cta'});
    button.addEventListener('click',()=>{const selected={...choices};const approval={deletions:[...deletions].filter(path=>selected[path]!=='local'),bulkDelete:bulk};button.disabled=true;
      void this.host.run(async()=>{if(!this.host.active())throw new Error('插件已停用。');const result=await this.port.apply(this.plan,selected,approval);if(this.closed)return;new Notice(appliedSummary(this.plan,selected,result.preserved),12000);this.close();if(this.after)await this.after();})
        .finally(()=>{if(!this.closed)button.disabled=false;});});
  }
  onClose():void{this.closed=true;this.untrack?.();this.contentEl.empty();void this.port.cancel?.().catch(()=>{new Notice('临时预览清理未完成，请重新打开检查。');});}
}

class HistoryModal extends Modal {
  private controller:PanelController;private entries:{hash:string;subject:string;date:string}[];private closed=false;
  private untrack?:()=>void;
  constructor(controller:PanelController,entries:{hash:string;subject:string;date:string}[]){super(controller.app);this.controller=controller;this.entries=entries;this.untrack=controller.trackWindow?.(()=>this.close());}
  onOpen():void{
    this.setTitle('提交历史');const list=this.contentEl.createDiv({cls:'wudao-git-list'});const files=this.contentEl.createDiv({cls:'wudao-git-list'});const preview=this.contentEl.createEl('pre',{cls:'wudao-git-preview'});
    for(const entry of this.entries){
      const button=list.createEl('button',{text:`${entry.hash.slice(0,8)} · ${entry.subject} · ${entry.date}`});
      button.addEventListener('click',()=>{void this.controller.run(async()=>{
        const changes=await this.controller.historyFiles(entry.hash);if(this.closed)return;files.empty();
        for(const file of changes){
          files.createEl('button',{text:`${file.status} · ${file.path}`}).addEventListener('click',()=>{void this.controller.run(async()=>{
            const text=await this.controller.historyPreview(entry.hash,file.path);if(!this.closed)preview.setText(text);
          });});
        }
      });});
    }
  }
  onClose():void{this.closed=true;this.untrack?.();this.contentEl.empty();}
}
