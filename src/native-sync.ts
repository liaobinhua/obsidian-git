import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { allowedDirectory, allowedPath, checkBytes, checkPaths, validSha, binding } from './mobile/policy.ts';
import type { Confirmation, PullPlan, Resolution } from './mobile/types.ts';

interface Tree { files: Record<string, string>; paths: string[]; directories: string[]; leaves: Record<string,string> }
interface Entry { path: string; before: string | null; after: string | null; staged?:string|null }
interface Plan { plan: PullPlan; local: string; branch: string; index: string; tree: Tree; incoming: Tree; entries: Entry[]; conflicts: Set<string>; temp?: string }
interface Journal { version: 1; repository: string; branch: string; oldHead: string; newHead: string; beforeIndex: string; afterIndex: string; entries: Entry[]; directories: string[] }
export interface NativePort {
  root: string; repository: string; url: string;
  run(args: string[], input?: Buffer | string, index?: string): Promise<Buffer>;
  transfer(args: string[]): Promise<Buffer>;
  guard(): Promise<{ head: string; branch: string; directory: string }>;
  indexDigest(): Promise<string>;
  read(path: string, raw?: boolean): Promise<Buffer | null>;
  indexRead(path:string):Promise<Buffer|null>;
  active?():boolean;
}
const digest = (bytes: Buffer | null) => bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex');
const encode = (bytes: Buffer | null) => bytes?.toString('base64') ?? null;
const decode = (body: string | null) => body === null ? null : Buffer.from(body, 'base64');
const snapshot = (value: object) => JSON.stringify(value);
const journalText=(journal:Journal)=>{const payload=snapshot(journal);return snapshot({version:1,payload,checksum:digest(Buffer.from(payload))});};
export const nativeMetadata=(path:string)=>path==='.gitignore'||path.endsWith('/.gitkeep')&&allowedDirectory(path.slice(0,-9))||path==='.gitkeep';
const syncPath=(path:string)=>allowedPath(path)||nativeMetadata(path);
const copyName=(path:string,kind:string)=>nativeMetadata(path)?path.replace(/\.git(ignore|keep)$/,(name)=>name.slice(1)+`.${kind}.txt`):path.slice(0,path.lastIndexOf('.'))+`.${kind}`+path.slice(path.lastIndexOf('.'));

/** Git objects provide history; a journal protects approved worktree writes. */
export class NativeSync {
  private port: NativePort;
  private plans = new Map<string, Plan>();
  private applying=false;private cancelled=new Set<string>();
  constructor(port: NativePort) { this.port = port; }
  private async text(args: string[], git?: string) { return (await this.port.run([...(git ? [`--git-dir=${git}`] : []), ...args])).toString('utf8').trim(); }
  private journalPath() { return join(this.port.root, '.git/wudao-sync-journal.json'); }
  async recovery(): Promise<boolean> { try { await lstat(this.journalPath()); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
  private alive(){if(this.port.active&&!this.port.active())throw new Error('插件已停用，本地恢复日志已保留。');}
  private async ready() { this.alive();if (await this.recovery()) throw new Error('上次本地同步中断，请先恢复同步。'); }
  private async tree(hash: string, git?: string): Promise<Tree> {
    if (!validSha(hash)) throw new Error('Git 提交标识无效。');
    const records = (await this.port.run([...(git ? [`--git-dir=${git}`] : []), 'ls-tree', '-r', '-z', hash])).toString('utf8').split('\0').filter(Boolean);
    const files: Record<string,string> = Object.create(null); const leaves:Record<string,string>=Object.create(null);const paths: string[] = []; const dirs = new Set<string>();
    if (records.length > 100000) throw new Error('仓库文件过多。');
    for (const record of records) {
      const tab = record.indexOf('\t'); const path = record.slice(tab+1); const [mode,type,sha] = record.slice(0,tab).split(' ');
      paths.push(path); for (let at=path.indexOf('/'); at>=0; at=path.indexOf('/',at+1)) dirs.add(path.slice(0,at));
      if(!validSha(sha))throw new Error('Git 文件对象无效。');leaves[path]=sha;
      if (!syncPath(path)) continue;
      if (type !== 'blob' || !['100644','100755'].includes(mode!) || !validSha(sha)) throw new Error(`文件 ${path} 不是普通文档。`);
      files[path] = sha;
    }
    checkPaths(paths, [...dirs]); return { files, paths, directories: [...dirs],leaves };
  }
  private async blob(hash: string | undefined, git?: string): Promise<Buffer | null> {
    if (!hash) return null; if (!validSha(hash)) throw new Error('文件对象标识无效。');
    if (Number(await this.text(['cat-file','-s',hash],git)) > 20*1024*1024) throw new Error('文件超过 20 MiB。');
    const bytes = await this.port.run([...(git ? [`--git-dir=${git}`] : []),'cat-file','blob',hash]); checkBytes(bytes); return bytes;
  }
  private async localPaths(): Promise<{ paths: string[]; directories: string[] }> {
    const paths: string[] = []; const directories: string[] = []; const pending=[''];
    while (pending.length) {
      const parent=pending.pop()!;
      if (parent.split('/').length>64) throw new Error('目录层级过深。');
      for (const entry of await readdir(join(this.port.root,parent),{withFileTypes:true})) {
        if (entry.name.startsWith('.')) continue;
        const path=parent ? parent+'/'+entry.name : entry.name;
        if (entry.isSymbolicLink()) throw new Error('文库包含链接，无法安全接入。');
        if (entry.isDirectory()) { directories.push(path); pending.push(path); } else if (entry.isFile()) paths.push(path); else throw new Error('文库包含非常规文件。');
        if (paths.length+directories.length>100000) throw new Error('文库文件过多。');
      }
    }
    checkPaths(paths,directories); return {paths,directories};
  }
  async planPull(): Promise<PullPlan> {
    await this.ready();await this.clearPlans();const state=await this.port.guard();
    await this.port.transfer(['fetch','--no-tags','--no-recurse-submodules',this.port.url,`+refs/heads/${state.branch}:refs/remotes/wudao-git/${state.branch}`]);
    const remote=await this.text(['rev-parse',`refs/remotes/wudao-git/${state.branch}`]);
    const base=await this.text(['merge-base',state.head,remote]);
    return this.plan(state.head,state.branch,remote,base);
  }
  async planAttach(branch='main'): Promise<PullPlan> {
    this.alive();await this.clearPlans();
    binding(this.port.repository,branch);
    try { await lstat(join(this.port.root,'.git')); throw new Error('此目录已有 Git 仓库，请直接检查远端更新。'); }
    catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    const temp=await mkdtemp(join(tmpdir(),'wudao-attach-'));
    try {
      await this.port.run(['init','--bare',temp]);
      await this.port.transfer([`--git-dir=${temp}`,'fetch','--no-tags','--no-recurse-submodules',this.port.url,`refs/heads/${branch}:refs/heads/${branch}`]);
      const head=await this.text(['rev-parse',`refs/heads/${branch}`],temp);
      return await this.plan('',branch,head,undefined,temp);
    } catch(e) { await rm(temp,{recursive:true,force:true}); throw e; }
  }
  private async plan(local: string, branch: string, remote: string, base?: string, temp?: string): Promise<PullPlan> {
    const indexDigest=local?await this.port.indexDigest():'missing';
    const incoming=await this.tree(remote,temp); const tree=local ? await this.tree(local) : {files:{},paths:[],directories:[],leaves:{}};
    const ancestor=base ? await this.tree(base) : {files:{},paths:[],directories:[],leaves:{}};
    if(local)for(const path of [...new Set([...ancestor.paths,...incoming.paths])]){
      if(!syncPath(path)&&incoming.leaves[path]!==ancestor.leaves[path])throw new Error(`远端修改了排除文件 ${path}，请先使用外部 Git 核对；本次不会生成丢弃该变化的合并提交。`);
    }
    const current=await this.localPaths(); checkPaths([...new Set([...current.paths,...incoming.paths])],[...new Set([...current.directories,...incoming.directories])]);
    const entries: Entry[]=[]; const conflicts=new Set<string>();
    const plan: PullPlan={id:randomUUID(),head:remote,initial:!local,changes:[],deletions:[],directories:incoming.directories.filter(path=>allowedDirectory(path)&&!current.directories.includes(path)),summary:{remoteFiles:incoming.paths.length,managedFiles:Object.keys(incoming.files).filter(allowedPath).length,metadataFiles:Object.keys(incoming.files).filter(nativeMetadata).length,remoteDirectories:incoming.directories.length,excluded:incoming.paths.filter(path=>!syncPath(path)).map(path=>({path,reason:'文件不在共享文档与附件范围内。'}))}};
    let total=0;
    plan.integration=!!local&&local!==remote&&base!==remote;
    for (const path of [...new Set([...Object.keys(tree.files),...Object.keys(incoming.files),...(!local?current.paths.filter(allowedPath):[])])].sort()) {
      const ours=tree.files[path], theirs=incoming.files[path], old=ancestor.files[path];
      if (local && (ours===theirs || old===theirs)) continue;
      const before=await this.port.read(path); const after=await this.blob(theirs,temp);
      const committed=await this.blob(ours);const staged=local?await this.port.indexRead(path):committed;const stagedChange=encode(staged)!==encode(committed);
      if (!local && !theirs) { plan.changes.push({path,kind:'local',deleted:false}); continue; }
      total+=(before?.length??0)+(after?.length??0)+(stagedChange?(staged?.length??0):0);
      if(total>50*1024*1024)throw new Error('同步与备份超过 50 MiB，请分批处理。');
      if (encode(before)===encode(after)&&!stagedChange) {
        plan.changes.push({path,kind:'same',deleted:after===null});
        entries.push({path,before:encode(before),after:encode(after)});continue;
      }
      const dirty=encode(before)!==encode(committed);
      const conflict=local ? ours!==old || dirty || stagedChange : before!==null;
      plan.changes.push({path,kind:conflict?'conflict':'remote',deleted:after===null});
      if (conflict) conflicts.add(path);
      if (after===null&&before!==null) plan.deletions.push(path);
      entries.push({path,before:encode(before),after:encode(after),...(stagedChange?{staged:encode(staged)}:{})});
    }
    if(local&&await this.port.indexDigest()!==indexDigest)throw new Error('暂存区在预览期间变化，请重新检查。');
    this.plans.set(plan.id,{plan:structuredClone(plan),local,branch,index:indexDigest,tree,incoming,entries,conflicts,temp});
    return plan;
  }
  async previewPull(plan: PullPlan,path: string): Promise<string> {
    const stored=this.plans.get(plan.id); if(!stored||!stored.plan.changes.some(c=>c.path===path))throw new Error('同步预览已失效。');
    const entry=stored.entries.find(e=>e.path===path);
    const display=(body:string|null)=>body===null?'（不存在）':!/\.(md|txt|csv)$/i.test(path)?`附件：${Buffer.from(body,'base64').length} 字节`:Buffer.from(body,'base64').toString('utf8').slice(0,50000);
    if (!entry) return '本地内容将保留；两端相同的文件将建立共同基线。';
    return `本地工作区\n${display(entry.before)}${entry.staged!==undefined?`\n\n本地暂存快照\n${display(entry.staged)}`:''}\n\n远端\n${display(entry.after)}`;
  }
  async discard(id:string):Promise<void>{
    if(this.applying){this.cancelled.add(id);return;}const plan=this.plans.get(id);this.plans.delete(id);if(plan?.temp)await rm(plan.temp,{recursive:true,force:true});
  }
  async clearPlans():Promise<void>{for(const id of [...this.plans.keys()])await this.discard(id);}
  async applyPull(plan: PullPlan,resolutions:Record<string,Resolution>={},confirmation?:Confirmation): Promise<{preserved:string[]}> {
    this.applying=true;try{return await this.apply(plan,resolutions,confirmation);}finally{this.applying=false;if(this.cancelled.delete(plan.id))await this.discard(plan.id);}
  }
  private async apply(plan: PullPlan,resolutions:Record<string,Resolution>,confirmation?:Confirmation):Promise<{preserved:string[]}>{
    await this.ready(); const stored=this.plans.get(plan.id); if(!stored)throw new Error('同步计划已失效。');
    const choices={...resolutions};
    for(const path of stored.conflicts)if(!['local','remote','both'].includes(choices[path]??''))throw new Error('请逐项处理冲突。');
    const entries:Entry[]=[]; const updates:Entry[]=[]; const namespace=await this.localPaths();
    checkPaths([...new Set([...namespace.paths,...stored.incoming.paths])],[...new Set([...namespace.directories,...stored.incoming.directories])]);
    for(const entry of stored.entries) {
      if(encode(await this.port.read(entry.path))!==entry.before)throw new Error('本地文件已变化，请重新检查。');
      if(stored.conflicts.has(entry.path)&&choices[entry.path]==='local')continue;
      if(stored.conflicts.has(entry.path)&&choices[entry.path]==='both') {
        let name=copyName(entry.path,'local-copy');let suffix=0;
        while([...namespace.paths,...namespace.directories,...stored.incoming.paths,...entries.map(e=>e.path)].some(path=>path.normalize('NFC').toLowerCase()===name.normalize('NFC').toLowerCase()))name=copyName(entry.path,`local-copy-${++suffix}`);
        if(entry.before!==null)entries.push({path:name,before:null,after:entry.before});
        if(entry.staged!==undefined&&entry.staged!==null&&entry.staged!==entry.before){
          let stagedName=copyName(entry.path,'staged-copy');let count=0;
          while([...namespace.paths,...namespace.directories,...stored.incoming.paths,...entries.map(e=>e.path)].some(path=>path.normalize('NFC').toLowerCase()===stagedName.normalize('NFC').toLowerCase()))stagedName=copyName(entry.path,`staged-copy-${++count}`);
          entries.push({path:stagedName,before:null,after:entry.staged});
        }
      }
      entries.push(entry);updates.push(entry);
    }
    const deletes=entries.filter(e=>e.after===null&&e.before!==null).map(e=>e.path).sort();
    if(entries.reduce((total,e)=>total+(decode(e.before)?.length??0)+(decode(e.after)?.length??0),0)>50*1024*1024)throw new Error('本次同步及备份超过 50 MiB，请分批处理。');
    if(deletes.length&&(!confirmation||snapshot([...new Set(confirmation.deletions)].sort())!==snapshot(deletes)||deletes.length>=2&&!confirmation.bulkDelete))throw new Error('请明确确认本次删除和批量删除。');
    const prefix=stored.temp?[`--git-dir=${stored.temp}`]:[];
    await this.port.transfer([...prefix,'fetch','--no-tags','--no-recurse-submodules',this.port.url,`+refs/heads/${stored.branch}:refs/remotes/wudao-git/check`]);
    if(await this.text(['rev-parse','refs/remotes/wudao-git/check'],stored.temp)!==stored.plan.head)throw new Error('远端已变化，请重新检查。');
    if(stored.local) {
      const now=await this.port.guard();if(now.head!==stored.local||now.branch!==stored.branch||await this.port.indexDigest()!==stored.index)throw new Error('提交或暂存区已变化，请重新检查。');
    }
    const temp=stored.temp??await mkdtemp(join(this.port.root,'.git/wudao-merge-'));const index=join(temp,'apply-index');
    try {
      await this.port.run([...prefix,'read-tree',stored.local||stored.plan.head],undefined,index);
      for(const entry of updates) {
        const hash=entry.after===null?'0'.repeat(40):(await this.port.run([...prefix,'hash-object','-w','--stdin','--no-filters'],decode(entry.after)!)).toString('utf8').trim();
        await this.port.run([...prefix,'update-index','-z','--index-info'],`${entry.after===null?'0':'100644'} ${hash}\t${entry.path}\0`,index);
      }
      const tree=(await this.port.run([...prefix,'write-tree'],undefined,index)).toString('utf8').trim();let next=stored.plan.head;
      if(stored.local&&stored.local!==stored.plan.head) {
        const remoteTree=await this.text(['rev-parse',`${stored.plan.head}^{tree}`]);
        const base=await this.text(['merge-base',stored.local,stored.plan.head]);
        if(base===stored.plan.head&&tree===await this.text(['rev-parse',`${stored.local}^{tree}`]))next=stored.local;
        else if(base!==stored.local||tree!==remoteTree)next=(await this.port.run(['commit-tree',tree,'-p',stored.local,'-p',stored.plan.head],'Wudao Git: reviewed synchronization\n')).toString('utf8').trim();
      }
      const afterIndex=join(temp,'after-index');
      if(stored.local)await cp(join(this.port.root,'.git/index'),afterIndex);else await this.port.run([...prefix,'read-tree',stored.plan.head],undefined,afterIndex);
      for(const entry of updates) {
        if(!stored.local)continue;
        const hash=entry.after===null?'0'.repeat(40):(await this.port.run(['hash-object','-w','--stdin','--no-filters'],decode(entry.after)!)).toString('utf8').trim();
        await this.port.run(['update-index','-z','--index-info'],`${entry.after===null?'0':'100644'} ${hash}\t${entry.path}\0`,afterIndex);
      }
      const beforeIndex=stored.local?await readFile(join(this.port.root,'.git/index')):await readFile(afterIndex);
      if(stored.local&&digest(beforeIndex)!==stored.index)throw new Error('暂存区在准备期间变化，请重新检查。');
      const journal:Journal={version:1,repository:this.port.repository,branch:stored.branch,oldHead:stored.local||next,newHead:next,beforeIndex:beforeIndex.toString('base64'),afterIndex:(await readFile(afterIndex)).toString('base64'),entries,directories:stored.incoming.directories.filter(allowedDirectory)};
      if(Buffer.byteLength(snapshot(journal))>80*1024*1024)throw new Error('恢复日志过大。');
      if(!stored.local) {
        try{await lstat(join(this.port.root,'.git'));throw new Error('目录已有新的 Git 仓库，请重新检查。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        await this.port.run([...prefix,'config','core.bare','false']);await this.port.run([...prefix,'config','remote.origin.url',this.port.url]);
        await this.port.run([...prefix,'config','user.name','Wudao Git']);await this.port.run([...prefix,'config','user.email','wudao-git@localhost']);
        await this.port.run([...prefix,'symbolic-ref','HEAD',`refs/heads/${stored.branch}`]);await cp(afterIndex,join(temp,'index'));
        await writeFile(join(temp,'wudao-sync-journal.json'),journalText(journal),{mode:0o600});
        const prepared=join(this.port.root,`.wudao-git-init-${randomUUID()}`);await cp(temp,prepared,{recursive:true});
        try{await rename(prepared,join(this.port.root,'.git'));}catch(e){await rm(prepared,{recursive:true,force:true});throw e;}
      }else await writeFile(this.journalPath(),journalText(journal),{flag:'wx',mode:0o600});
      const result=await this.recover();this.plans.delete(plan.id);return result;
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  private async ensure(path:string) {
    this.alive();
    let current=this.port.root;
    for(const part of path.split('/')) {current=join(current,part);try{const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('目录包含文件或链接。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await mkdir(current);}}
  }
  async recover():Promise<{preserved:string[]}> {
    if(!await this.recovery())return {preserved:[]};
    const raw=await readFile(this.journalPath(),'utf8');if(Buffer.byteLength(raw)>80*1024*1024)throw new Error('恢复日志过大。');
    const envelope=JSON.parse(raw) as {version:unknown;payload:unknown;checksum:unknown};
    if(envelope.version!==1||typeof envelope.payload!=='string'||envelope.checksum!==digest(Buffer.from(envelope.payload)))throw new Error('本地恢复日志校验失败，请保留备份。');
    const journal=JSON.parse(envelope.payload) as Journal;
    binding(journal.repository,journal.branch);
    if(journal.version!==1||journal.repository!==this.port.repository||!validSha(journal.oldHead)||!validSha(journal.newHead)||!Array.isArray(journal.entries)||!Array.isArray(journal.directories))throw new Error('恢复日志无效，请保留原文件。');
    for(const entry of journal.entries) {
      if(!syncPath(entry.path)||![entry.before,entry.after].every(value=>value===null||typeof value==='string'&&encode(decode(value))===value))throw new Error('恢复文件记录无效。');
      for(const value of [entry.before,entry.after])if(value!==null)checkBytes(decode(value)!);
    }
    if(journal.directories.some(path=>!allowedDirectory(path)))throw new Error('恢复目录无效。');
    checkPaths(journal.entries.map(e=>e.path),journal.directories);
    const state=await this.port.guard();if(![journal.oldHead,journal.newHead].includes(state.head)||state.branch!==journal.branch)throw new Error('Git 提交已由其他操作更新，请保留恢复日志。');
    const actualIndex=await readFile(join(this.port.root,'.git/index'));if(![journal.beforeIndex,journal.afterIndex].includes(actualIndex.toString('base64')))throw new Error('暂存区已由其他操作更新，请保留恢复日志。');
    const lock=join(this.port.root,'.git/index.lock');const handle=await open(lock,'wx',0o600);await handle.close();const preserved:string[]=[];let installed=false;
    try {
      const namespace=await this.localPaths();checkPaths([...new Set([...namespace.paths,...journal.entries.map(e=>e.path)])],[...new Set([...namespace.directories,...journal.directories])]);
      for(const directory of journal.directories)await this.ensure(directory);
      for(const entry of journal.entries) {
        const actual=await this.port.read(entry.path,true);if(encode(actual)===entry.after)continue;
        this.alive();
        if(encode(actual)!==entry.before){if(entry.before!==null)await this.backup(entry.path,entry.before);preserved.push(entry.path);continue;}
        if(entry.after===null)await rm(join(this.port.root,entry.path));
        else {
          const slash=entry.path.lastIndexOf('/');if(slash>=0)await this.ensure(entry.path.slice(0,slash));
          const file=await open(join(this.port.root,entry.path),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
          try{await file.writeFile(decode(entry.after)!);}finally{await file.close();}
        }
        if(encode(await this.port.read(entry.path,true))!==entry.after)throw new Error('文件写入校验失败，请恢复同步。');
      }
      if((await this.port.guard()).head!==state.head||await this.port.indexDigest()!==digest(actualIndex))throw new Error('Git 状态在恢复期间变化，请保留日志。');
      this.alive();
      await writeFile(lock,Buffer.from(journal.afterIndex,'base64'));
      if(state.head!==journal.newHead)await this.port.run(['update-ref','-m','Wudao Git: reviewed sync',`refs/heads/${journal.branch}`,journal.newHead,journal.oldHead]);
      this.alive();await rename(lock,join(this.port.root,'.git/index'));installed=true;await rm(this.journalPath());return {preserved};
    }finally{if(!installed)await rm(lock,{force:true});}
  }
  private async backup(path:string,body:string):Promise<void>{
    const slash=path.lastIndexOf('/');if(slash>=0)await this.ensure(path.slice(0,slash));
    for(let suffix=0;suffix<10000;suffix++){
      const name=copyName(path,`recovery-copy${suffix?'-'+suffix:''}`);
      try{const actual=await this.port.read(name,true);if(actual){if(encode(actual)===body)return;continue;}
        const file=await open(join(this.port.root,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{await file.writeFile(decode(body)!);}finally{await file.close();}return;
      }catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    }throw new Error('恢复备份重名过多，请保留日志。');
  }
}
