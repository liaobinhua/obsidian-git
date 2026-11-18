import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('shared source-control view distinguishes staged and working changes and retains previews during refresh',async()=>{
  class Element {
    tag:string;text:string;value='';checked=false;children:Element[]=[];events:Record<string,()=>void>={};
    constructor(tag:string,options:{text?:string}={}){this.tag=tag;this.text=options.text??'';}
    createEl(tag:string,options?:{text?:string}){const child=new Element(tag,options);this.children.push(child);return child;}
    createDiv(options?:{text?:string}){return this.createEl('div',options);}createSpan(options?:{text?:string}){return this.createEl('span',options);}
    empty(){this.children=[];}addClass(){}setText(text:string){this.text=text;}addEventListener(event:string,callback:()=>void){this.events[event]=callback;}
  }
  type View={onOpen():Promise<void>;onClose():Promise<void>;refresh():Promise<void>;contentEl:Element};
  let factory!:(leaf:unknown)=>View;
  const app={vault:{adapter:{stat:async()=>null},configDir:'.obsidian',on:()=>({})},secretStorage:{getSecret:()=> 'fixture'},workspace:{on:()=>({}),iterateAllLeaves(){},getActiveFile:()=>({path:'note.md'}),getLeavesOfType:()=>[]}};
  class Plugin{
    app=app;manifest={id:'wudao-git',dir:'.obsidian/plugins/wudao-git'};async loadData(){return {};}
    addStatusBarItem(){return {setText(){}};}addSettingTab(){}addRibbonIcon(){}addCommand(){}
    registerView(_type:string,view:(leaf:unknown)=>View){factory=view;}
  }
  class ItemView{app=app;contentEl=new Element('root');registerEvent(){}}
  class Notice{hide(){}}
  const sdk={Plugin,ItemView,Notice,Modal:class {open(){}},PluginSettingTab:class {},Platform:{isAndroidApp:true},TextFileView:class {},TFile:class {}};
  interface Probe{onload():Promise<void>;showPull():Promise<void>;settings:{repository:string;secretName:string};repository():unknown}
  const module={exports:{} as {default?:new()=>Probe}};
  runInNewContext(await readFile(new URL('../../dist/android/main.js',import.meta.url),'utf8'),{
    module,exports:module.exports,require:(id:string)=>{assert.equal(id,'obsidian');return sdk;},crypto,TextEncoder,TextDecoder,URL,Uint8Array,ArrayBuffer,AbortController,setTimeout,clearTimeout,btoa,atob,window:{setTimeout,clearTimeout},
  });
  assert.ok(module.exports.default);const plugin=new module.exports.default();await plugin.onload();plugin.settings.repository='example/notes';plugin.settings.secretName='fixture';
  const file={path:'note.md',status:'modify',allowed:true,reason:'',digest:'b'.repeat(40)};let working=false;
  let gate:Promise<void>|undefined;let started:(()=>void)|undefined;let inspecting=false;let planCalls=0;
  const engine={
    inspectVault:async()=>{if(inspecting)throw new Error('concurrent inspection');inspecting=true;try{if(gate){started?.();await gate;gate=undefined;}return {repository:'example/notes',branch:'main',head:'a'.repeat(40),initialized:true,recovery:false,pendingUpload:false,changes:[file],workingChanges:working?[{...file,digest:'c'.repeat(40)}]:[],staged:{id:'stage',head:'a'.repeat(40),changes:[file]}};}finally{inspecting=false;}},
    preview:async(_review:unknown,_path:string,options?:{remote?:boolean})=>{if(options?.remote)throw new Error('401');return '基线 A\n已暂存 B';},
    planPull:async()=>{planCalls++;return {id:'plan',head:'a'.repeat(40),initial:false,changes:[],directories:[],deletions:[],summary:{remoteFiles:1,remoteDirectories:0,managedFiles:1,excluded:[]}};},
  };plugin.repository=()=>engine;
  const view=factory({});await view.onOpen();
  const flatten=(node:Element):Element[]=>[node,...node.children.flatMap(flatten)];
  let nodes=flatten(view.contentEl);assert(nodes.some(n=>n.text==='工作区变化（0）'));assert(nodes.some(n=>n.text==='已暂存的待上传快照（1）'));
  assert(nodes.some(n=>n.text==='当前文件：note.md · 已暂存'));
  const button=nodes.find(n=>n.tag==='button'&&n.text==='查看差异');assert.ok(button);button.events.click!();await new Promise(resolve=>setTimeout(resolve,0));
  nodes=flatten(view.contentEl);assert(nodes.some(n=>n.tag==='pre'&&n.text==='基线 A\n已暂存 B'),'refresh must retain the loaded diff');
  const online=nodes.find(n=>n.tag==='button'&&n.text==='联网补全基线');assert.ok(online);online.events.click!();await new Promise(resolve=>setTimeout(resolve,0));
  nodes=flatten(view.contentEl);assert(nodes.some(n=>n.tag==='pre'&&n.text.includes('已暂存 B')&&n.text.includes('远端基线正文暂不可用')),'a missing credential must not hide the cached snapshot');
  const input=nodes.find(n=>n.tag==='input'&&!n.events.change);assert.ok(input);input.value='保留提交说明';input.events.input!();
  working=true;await view.refresh();nodes=flatten(view.contentEl);
  assert(nodes.some(n=>n.text==='工作区变化（1）'));assert(nodes.some(n=>n.text==='当前文件：note.md · 已暂存，另有工作区变化'));
  assert(nodes.some(n=>n.tag==='input'&&n.value==='保留提交说明'));
  let release!:()=>void;gate=new Promise<void>(resolve=>{release=resolve;});const entered=new Promise<void>(resolve=>{started=resolve;});
  const background=view.refresh();await entered;const checking=plugin.showPull();assert.equal(planCalls,0);release();await Promise.all([background,checking]);assert.equal(planCalls,1,'manual check must wait for background inspection instead of being rejected');
  await view.onClose();
});
