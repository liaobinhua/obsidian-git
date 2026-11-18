import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileEngine, GitHubClient, GitHubError, allowedDirectory, allowedPath } from '../src/mobile/index.ts';
import type { LocalFiles, MobileState, RequestOptions, StateStore } from '../src/mobile/types.ts';
import { fromBase64 } from '../src/mobile/policy.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | null) => bytes === null ? null : new TextDecoder().decode(bytes);

class Files implements LocalFiles {
  data = new Map<string, Uint8Array>();
  directories = new Set<string>();
  links: string[] = [];
  fail = '';
  partial = '';
  failDirectory = '';
  async list(): ReturnType<LocalFiles['list']> {
    const directories=new Set(this.directories);
    for(const path of this.data.keys())for(let slash=path.indexOf('/');slash>=0;slash=path.indexOf('/',slash+1))directories.add(path.slice(0,slash));
    return [...[...this.data.keys()].map(path=>({path,kind:'file' as const})),...[...directories].map(path=>({path,kind:'directory' as const})),...this.links.map(path=>({path,kind:'symlink' as const}))];
  }
  async read(path: string) { if(this.directories.has(path))throw new Error('path is a directory');return this.data.get(path)?.slice() ?? null; }
  async write(path: string, bytes: Uint8Array) {
    if(this.directories.has(path))throw new Error('path is a directory');
    if (path === this.fail) throw new Error('device disconnected');
    if (path === this.partial) {this.data.set(path,bytes.slice(0,2));throw new Error('partial host write');}
    this.data.set(path, bytes.slice());
  }
  async remove(path: string) { this.data.delete(path); }
  async mkdir(path: string) {
    if (this.data.has(path)) throw new Error('path is a file');
    if (path === this.failDirectory) throw new Error('directory creation interrupted');
    if ([...this.data.keys()].some(file => file.startsWith(`${path}/`))) return;
    this.directories.add(path);
  }
  set(path: string, text: string) { this.data.set(path, encode(text)); }
  text(path: string) { return decode(this.data.get(path) ?? null); }
}
class Store implements StateStore {
  state: MobileState | null = null;
  saves = 0;
  failAt = 0;
  async load() { return structuredClone(this.state); }
  async save(state: MobileState) { if (++this.saves === this.failAt) throw new Error('persistence interrupted'); this.state = structuredClone(state); }
}

async function fixture(initial: Record<string, string | Uint8Array> = { 'first.md': 'one\ntwo\nthree\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'mobile-git-'));
  cleanup.push(() => rm(root, {recursive:true, force:true}));
  const run = (args: string[], input?: string | Uint8Array, index?: string) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
    input, encoding: 'utf8', env: {...process.env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', ...(args[0] === 'init' ? {} : {GIT_WORK_TREE:root,GIT_DIR:root}), GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@local.invalid', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@local.invalid', ...(index ? {GIT_INDEX_FILE:index}: {})},
  }).trim();
  run(['init','--bare','-b','main']);
  let sequence = 0;
  function tree(base: string | null, files: Record<string,string | Uint8Array | null>) {
    const index = join(root, `index-${sequence++}`);
    run(base ? ['read-tree',base] : ['read-tree','--empty'], undefined,index);
    for(const [path,bytes] of Object.entries(files)) {
      if(bytes === null) {run(['update-index','--force-remove','--',path],undefined,index); continue;}
      const sha=run(['hash-object','-w','--stdin'],bytes);
      run(['update-index','--add','--cacheinfo',`100644,${sha},${path}`],undefined,index);
    }
    return run(['write-tree'],undefined,index);
  }
  let head=run(['commit-tree',tree(null,initial),'-m','Initial']); run(['update-ref','refs/heads/main',head]);
  const current=()=>run(['rev-parse','main']);
  const advance=(files:Record<string,string | Uint8Array | null>)=> {
    head=run(['commit-tree',tree(`${current()}^{tree}`,files),'-p',current(),'-m','Remote']); run(['update-ref','refs/heads/main',head]); return head;
  };
  const controls={offline:false,truncated:false,invalid:false,status:0,timeoutAfterRef:false,raceBeforeRef:false, transform:undefined as ((path:string,json:unknown)=>unknown)|undefined, requests:[] as RequestOptions[]};
  const server: Server=createServer(async(req,res)=> {
    let raw=''; for await(const part of req) raw+=part;
    const body=raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const path=decodeURI(new URL(req.url!,'http://localhost').pathname).replace('/repos/example/notes/git/','');
    const answer=(status:number,json:unknown)=>{res.writeHead(status,{'content-type':'application/json','x-ratelimit-remaining':'0','x-ratelimit-reset':'1234'});res.end(JSON.stringify(controls.transform?.(path,json) ?? json));};
    if(controls.status) return answer(controls.status,{message:'private server message token SHOULD_NOT_LEAK'});
    if(controls.invalid) return answer(200,{bad:true});
    if(path==='ref/heads/main' || path==='refs/heads/main' && req.method==='GET') return answer(200,{ref:'refs/heads/main',object:{type:'commit',sha:current()}});
    if(path.startsWith('commits/') && req.method==='GET') return answer(200,{sha:path.slice(8),tree:{sha:run(['rev-parse',`${path.slice(8)}^{tree}`])}});
    if(path.startsWith('trees/') && req.method==='GET') {
      const entries=run(['ls-tree','-rz','-r','-t',path.slice(6)]).split('\0').filter(Boolean).map(line=>{
        const match=/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line)!;
        return {mode:match[1],type:match[2],sha:match[3],path:match[4],size: Number(run(['cat-file','-s',match[3]!]))};
      });
      return answer(200,{sha:path.slice(6),truncated:controls.truncated,tree:entries});
    }
    if(path.startsWith('blobs/') && req.method==='GET') {
      const content=execFileSync('/usr/bin/git',['-C',root,'cat-file','blob',path.slice(6)],{maxBuffer:32*1024*1024});
      return answer(200,{sha:path.slice(6),encoding:'base64',size:content.length,content:content.toString('base64')});
    }
    if(path==='blobs' && req.method==='POST') return answer(201,{sha:run(['hash-object','-w','--stdin'],Buffer.from(String(body.content),'base64'))});
    if(path==='trees' && req.method==='POST') {
      const index=join(root,`index-${sequence++}`);run(['read-tree',String(body.base_tree)],undefined,index);
      for(const item of body.tree as {path:string;sha:string|null;mode:string}[]) {
        run(item.sha ? ['update-index','--add','--cacheinfo',`${item.mode},${item.sha},${item.path}`]:['update-index','--force-remove','--',item.path],undefined,index);
      }
      return answer(201,{sha:run(['write-tree'],undefined,index)});
    }
    if(path==='commits' && req.method==='POST') return answer(201,{sha:run(['commit-tree',String(body.tree),'-p',String((body.parents as string[])[0]),'-m',String(body.message)]),tree:{sha:body.tree},parents:(body.parents as string[]).map(sha=>({sha}))});
    if(path==='refs/heads/main' && req.method==='PATCH') {
      assert.equal(body.force,false);
      if(controls.raceBeforeRef) {controls.raceBeforeRef=false;advance({'race.md':'remote'});}
      try {run(['merge-base','--is-ancestor',current(),String(body.sha)]);} catch{return answer(422,{message:'not fast forward'});}
      run(['update-ref','refs/heads/main',String(body.sha)]);
      if(controls.timeoutAfterRef){controls.timeoutAfterRef=false;res.destroy();return;}
      return answer(200,{object:{type:'commit',sha:current()}});
    }
    answer(404,{message:'unknown test route'});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address(); assert(address && typeof address!=='string');
  const request=async(options:RequestOptions)=> {
    controls.requests.push(structuredClone(options));
    assert.equal(new URL(options.url).origin,'https://api.github.com');
    if(controls.offline) throw new Error('network token SHOULD_NOT_LEAK');
    const reply=await fetch(`http://127.0.0.1:${address.port}${new URL(options.url).pathname}${new URL(options.url).search}`,{method:options.method,headers:options.headers,...(options.body ? {body:options.body}:{}),redirect:'error'});
    return {status:reply.status,headers:Object.fromEntries(reply.headers),json:await reply.json() as unknown};
  };
  const files=new Files(); const store=new Store();
  const client=new GitHubClient({repository:'example/notes',branch:'main',token:async()=>'fixture-only',request});
  const make=()=>new MobileEngine({repository:'example/notes',branch:'main',files,store,client});
  const engine=make();
  const imported=async()=>{await engine.applyPull(await engine.planPull());};
  return {root,run,files,store,engine,client,make,controls,advance,current,imported};
}

describe('portable mobile synchronization against a local HTTP and bare Git fixture',()=> {
  const complete = () => ({
    'inbox/a.md':'a','notes/b.md':'b','notes/c.md':'c','archive/d.md':'d','archive/e.md':'e',
    ...Object.fromEntries(Array.from({length:7},(_,i)=>[`empty-${i}/.gitkeep`,''])),'.gitignore':'ignored',
  });
  it('imports all ten safe directories and reports every excluded leaf without reading placeholder bodies',async()=>{
    const f=await fixture(complete());const remote=await f.client.snapshot();
    assert.equal(remote.totalFiles,13);assert.equal(remote.totalDirectories,10);assert.equal(remote.directories.length,10);
    const plan=await f.engine.planPull();assert.equal(plan.directories.length,10);
    assert.equal(plan.summary.remoteFiles,13);assert.equal(plan.summary.managedFiles,5);assert.equal(plan.summary.remoteDirectories,10);
    assert.equal(plan.summary.excluded.length,8);assert(plan.summary.excluded.every(entry=>entry.reason.length>0));
    assert(plan.summary.excluded.some(entry=>entry.path==='.gitignore'));assert(plan.summary.excluded.some(entry=>entry.path==='empty-0/.gitkeep'));
    await f.engine.applyPull(plan);assert.equal(f.files.directories.size,10);assert.equal(f.files.data.size,5);
    assert.equal(f.controls.requests.filter(request=>new URL(request.url).pathname.includes('/blobs/')).length,5);
    f.files.set('inbox/a.md','reviewed');await f.engine.upload(await f.engine.review(),['inbox/a.md'],'selected');
    assert.equal(f.run(['show',`${f.current()}:empty-0/.gitkeep`]),'');assert.equal(f.run(['show',`${f.current()}:.gitignore`]),'ignored');
  });
  it('keeps directory security restrictions and retains local folders removed from the remote tree',async()=>{
    for(const path of ['.obsidian','config','configs','keys','ssh','safe/private-keys','safe/tokens','../outside'])assert.equal(allowedDirectory(path),false,path);
    const f=await fixture({'safe/nested/.gitkeep':'','.obsidian/config.json':'private','config/settings.md':'private','keys/a.txt':'private'});
    const plan=await f.engine.planPull();assert.deepEqual(plan.directories,['safe','safe/nested']);assert.equal(plan.summary.excluded.length,4);
    await f.engine.applyPull(plan);assert.equal(f.files.data.size,0);assert.equal(f.controls.requests.some(request=>new URL(request.url).pathname.includes('/blobs/')),false);
    f.advance({'safe/nested/.gitkeep':null});const next=await f.engine.planPull();await f.engine.applyPull(next);
    assert.deepEqual([...f.files.directories],['safe','safe/nested']);assert.equal(next.directories.length,0);
  });
  it('rejects remote empty directory case, Unicode and file-directory collisions before any local write',async()=>{
    for(const [left,right] of [['Empty','empty'],['caf\u00e9','cafe\u0301'],['first.md','first.md']]) {
      const f=await fixture();f.controls.transform=(path,json)=>{
        if(path.startsWith('trees/')) {const value=json as {tree:Record<string,unknown>[]};value.tree.push(...[left,right].map(name=>({path:name,type:'tree',mode:'040000',sha:'0'.repeat(40)})));}
        return json;
      };
      await assert.rejects(f.engine.planPull(),/冲突|collision/);assert.equal(f.store.saves,0);assert.equal(f.files.directories.size,0);
    }
  });
  it('fills seven missing placeholder directories on the same old baseline while preserving files and a saved draft',async()=>{
    const f=await fixture(complete());await f.imported();f.files.directories.clear();
    f.files.set('inbox/a.md','unsynced');await f.engine.review();const before=structuredClone(f.store.state!);const requests=f.controls.requests.length;
    const plan=await f.make().planPull();assert.equal(plan.directories.length,7);assert.equal(plan.initial,false);
    const engine=f.make();const next=await engine.planPull();await engine.applyPull(next);
    assert.equal(f.files.text('inbox/a.md'),'unsynced');assert.equal(f.files.directories.size,7);
    assert.equal(f.store.state!.head,before.head);assert.deepEqual(f.store.state!.baseline,before.baseline);assert.deepEqual(f.store.state!.draft,before.draft);
    assert.equal(f.controls.requests.slice(requests).filter(request=>new URL(request.url).pathname.includes('/blobs/')).length,0);
  });
  it('journals directories before writes and recovers interrupted creation idempotently',async()=>{
    const f=await fixture({'a/.gitkeep':'','b/.gitkeep':'','note.md':'note'});f.files.failDirectory='b';
    await assert.rejects(f.imported(),/interrupted/);assert.deepEqual(f.store.state!.journal!.directories,['a','b']);assert.equal(f.files.data.size,0);
    f.files.set('user.md','later edit');f.files.failDirectory='';await f.make().recover();
    assert.equal(f.files.text('user.md'),'later edit');assert.equal(f.files.text('note.md'),'note');assert.deepEqual([...f.files.directories].sort(),['a','b']);
    await f.make().recover();assert.equal(f.files.text('user.md'),'later edit');assert.equal(f.store.state!.journal,undefined);
  });
  it('restores safe directories removed after preview and returns a directory-only apply result',async()=>{
    const f=await fixture({'empty/.gitkeep':''});f.files.directories.add('empty');
    const plan=await f.engine.planPull();assert.deepEqual(plan.directories,[]);f.files.directories.delete('empty');
    const result=await f.engine.applyPull(plan);assert.deepEqual(result,{preserved:[]});assert(f.files.directories.has('empty'));
    assert.equal(f.store.state!.head,f.current());assert.equal(f.files.data.size,0);
  });
  it('restores previously existing safe directories removed during recovery',async()=>{
    const f=await fixture({'empty/.gitkeep':'','z/.gitkeep':''});f.files.directories.add('empty');
    const plan=await f.engine.planPull();assert.deepEqual(plan.directories,['z']);f.files.failDirectory='z';
    await assert.rejects(f.engine.applyPull(plan),/interrupted/);assert.deepEqual(f.store.state!.journal!.directories,['empty','z']);
    const list=f.files.list.bind(f.files);let scans=0;f.files.list=async()=>{if(++scans===2)f.files.directories.delete('empty');return list();};
    f.files.failDirectory='';await f.make().recover();
    assert.deepEqual([...f.files.directories].sort(),['empty','z']);assert.equal(f.store.state!.journal,undefined);
  });
  it('bounds complete recovery inventory scans independently of one or one hundred existing directories',async()=>{
    const counts: number[]=[];
    for(const count of [1,100]) {
      const f=await fixture({});const directories=Array.from({length:count},(_,i)=>`folder-${i}`);
      for(const path of directories)f.files.directories.add(path);
      f.store.state={version:1,repository:'example/notes',branch:'main',head:'',baseline:{},journal:{
        head:f.current(),baseline:{},entries:[],directories,inventory:{files:directories.map(path=>`${path}/.gitkeep`),directories},
      }};
      const list=f.files.list.bind(f.files);let scans=0;f.files.list=async()=>{scans++;return list();};
      await f.make().recover();counts.push(scans);assert(scans<=3,`${count} directories triggered ${scans} full scans`);
      assert.equal(f.files.directories.size,count);assert.equal(f.files.data.size,0);assert.equal(f.store.state!.journal,undefined);
    }
    assert.equal(counts[0],counts[1]);
  });
  it('detects namespace collisions introduced during directory creation before writing document bodies',async()=>{
    const f=await fixture({'empty/.gitkeep':'','note.md':'remote'});const mkdir=f.files.mkdir.bind(f.files);
    f.files.mkdir=async(path)=>{await mkdir(path);f.files.set('Empty','user file');};
    await assert.rejects(f.imported(),/冲突|collision/);assert.equal(f.files.text('Empty'),'user file');assert.equal(f.files.text('note.md'),null);assert(f.store.state!.journal);
  });
  it('verifies and repairs required directories once more after document writes',async()=>{
    const f=await fixture({'empty/.gitkeep':'','note.md':'remote'});const write=f.files.write.bind(f.files);
    f.files.write=async(path,bytes)=>{await write(path,bytes);f.files.directories.delete('empty');};
    await f.imported();assert(f.files.directories.has('empty'));assert.equal(f.files.text('note.md'),'remote');assert.equal(f.store.state!.journal,undefined);
  });
  it('keeps the journal and stops before document writes when directory removals continue during bounded repair',async()=>{
    const f=await fixture({'a/.gitkeep':'','b/.gitkeep':'','note.md':'remote'});const mkdir=f.files.mkdir.bind(f.files);
    f.files.mkdir=async(path)=>{await mkdir(path);f.files.directories.delete(path==='a'?'b':'a');};
    await assert.rejects(f.imported(),/目录.*创建验证失败/);assert.equal(f.files.text('note.md'),null);assert(f.store.state!.journal);
  });
  it('returns apply-time preserved paths when later user edits replace reviewed file contents',async()=>{
    const f=await fixture();await f.imported();f.advance({'first.md':'remote replacement'});const plan=await f.engine.planPull();
    f.controls.transform=(path,json)=>{if(path==='ref/heads/main')f.files.set('first.md','later user edit');return json;};
    const result=await f.engine.applyPull(plan);assert.deepEqual(result,{preserved:['first.md']});
    assert.equal(f.files.text('first.md'),'later user edit');assert.equal(f.files.text('first.recovery-copy.md'),'one\ntwo\nthree\n');
    assert.equal((await f.engine.review()).changes.find(change=>change.path==='first.md')?.status,'modify');
  });
  it('checks full directory inventories for case, Unicode and file collisions before journals and during recovery',async()=>{
    for(const [remoteDirectory,localPath] of [['Empty','empty'],['caf\u00e9','cafe\u0301'],['folder','folder']]) {
      const f=await fixture({[`${remoteDirectory}/.gitkeep`]:''});f.files.set(localPath!,'user');
      // An existing initialized vault may contain its own unsupported local file.
      f.store.state={version:1,repository:'example/notes',branch:'main',head:f.current(),baseline:{}};
      await assert.rejects(f.engine.planPull(),/冲突|collision/);assert.equal(f.store.saves,0);assert.equal(f.files.text(localPath!),'user');
    }
    const f=await fixture({'Empty/.gitkeep':'','later/.gitkeep':''});f.files.failDirectory='Empty';await assert.rejects(f.imported());
    f.files.failDirectory='';f.files.set('empty','later user file');await assert.rejects(f.make().recover(),/冲突|collision/);
    assert.equal(f.files.text('empty'),'later user file');assert(f.store.state!.journal);assert.equal(f.files.directories.size,0);
  });
  it('names every required unsafe remote file and leaves no false-complete state',async()=>{
    for(const failure of ['large','corrupt','secret','sha']) {
      const f=await fixture({'required.md':failure==='secret'?'-----BEGIN PRIVATE KEY-----':'required'});
      f.controls.transform=(path,json)=>{
        if(failure==='large'&&path.startsWith('trees/')) {const value=json as {tree: {type:string;size:number}[]};value.tree.find(entry=>entry.type==='blob')!.size=21*1024*1024;}
        if(failure==='corrupt'&&path.startsWith('blobs/'))(json as {content:string}).content='AAAA';
        if(failure==='sha'&&path.startsWith('trees/'))(json as {tree: {sha:string}[]}).tree[0]!.sha='invalid';
        return json;
      };
      await assert.rejects(f.engine.planPull(),error=>error instanceof Error&&error.message.includes('required.md'));
      assert.equal(f.store.state,null);assert.equal(f.files.data.size,0);assert.equal(f.files.directories.size,0);
    }
  });
  it('requires an actual filename extension in the shared upload policy',()=>{
    for(const path of ['md','txt','png','folder/md','folder/pdf','folder.csv/txt'])assert.equal(allowedPath(path),false,path);
    assert.equal(allowedPath('中文/note.MD'),true);
  });
  it('imports into an empty document vault; preserves excluded remote files on selected upload',async()=>{
    const f=await fixture({'first.md':'first','.obsidian/config.json':'private','工具/data.txt':'你好'});await f.imported();
    assert.equal(f.files.text('工具/data.txt'),'你好'); assert.equal(f.files.text('.obsidian/config.json'),null);
    f.files.set('first.md','changed'); f.files.set('draft.md','not selected');
    const head=await f.engine.upload(await f.engine.review(),['first.md'],'Reviewed');
    assert.equal(head,f.current()); assert.equal(f.run(['show',`${head}:first.md`]),'changed');
    assert.equal(f.run(['show',`${head}:.obsidian/config.json`]),'private');
    assert.equal((await f.engine.review()).changes.find(c=>c.path==='draft.md')?.status,'add');
    assert.equal(f.run(['rev-list','--parents','-n','1',head]).split(' ').length,2);
  });
  it('refuses initial import into a dirty vault, including unsupported documents',async()=>{
    const f=await fixture();f.files.set('personal.docx','keep');await assert.rejects(f.engine.planPull(),/空|empty/);assert.equal(f.files.text('personal.docx'),'keep');
  });
  it('reviews and previews offline; rejects changed selections and secrets without requests',async()=>{
    const f=await fixture();await f.imported();f.controls.offline=true;const count=f.controls.requests.length;
    f.files.set('first.md','local');f.files.set('secret.md','-----BEGIN PRIVATE KEY-----');
    const review=await f.engine.review();assert.match(await f.engine.preview(review,'first.md'),/local/);
    assert.equal(review.changes.find(c=>c.path==='secret.md')?.allowed,false);
    assert.equal(f.controls.requests.length,count);f.files.set('first.md','later');
    await assert.rejects(f.engine.upload(review,['first.md'],'reviewed'),/变化|changed/);
    assert.equal(f.controls.requests.length,count);assert(!JSON.stringify(f.store.state).includes('PRIVATE KEY'));
  });
  it('roundtrips binary attachments and Chinese paths',async()=>{
    const bytes=new Uint8Array([0,255,128,1]);const f=await fixture({'中文/图.png':bytes});await f.imported();assert.deepEqual(await f.files.read('中文/图.png'),bytes);
    f.files.data.set('中文/图.png',new Uint8Array([255,0,2]));await f.engine.upload(await f.engine.review(),['中文/图.png'],'image');
    assert.deepEqual(execFileSync('/usr/bin/git',['-C',f.root,'show',`${f.current()}:中文/图.png`]),Buffer.from([255,0,2]));
  });
  it('keeps disjoint file edits and pauses on any differing same-file edits',async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','ONE\ntwo\nthree\n');f.advance({'first.md':'one\ntwo\nTHREE\n'});
    const plan=await f.engine.planPull();assert.equal(plan.changes[0]?.kind,'conflict');await assert.rejects(f.engine.applyPull(plan),/冲突|conflict/);
    const conflict=plan;
    await assert.rejects(f.engine.applyPull(conflict),/冲突|conflict/);assert.equal(f.files.text('first.md'),'ONE\ntwo\nthree\n');
    await f.engine.applyPull(conflict,{'first.md':'both'});assert.equal(f.files.text('first.md'),'one\ntwo\nTHREE\n');
    assert([...f.files.data.values()].some(v=>decode(v)==='ONE\ntwo\nthree\n'));
  });
  for(const resolution of ['local','remote'] as const) it(`resolves a conflict using ${resolution}`,async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','local');f.advance({'first.md':'remote'});
    await f.engine.applyPull(await f.engine.planPull(),{'first.md':resolution});assert.equal(f.files.text('first.md'),resolution);
    assert.equal((await f.engine.review()).changes.length,resolution==='local'?1:0);
  });
  it('requires exact deletion preview and bulk confirmation for pull and upload',async()=>{
    const f=await fixture({'a.md':'a','b.md':'b'});await f.imported();f.advance({'a.md':null,'b.md':null});const plan=await f.engine.planPull();
    await assert.rejects(f.engine.applyPull(plan),/删除|delet/);await assert.rejects(f.engine.applyPull(plan,{}, {deletions:['a.md','b.md'],bulkDelete:false}),/批量|bulk/);
    await f.engine.applyPull(plan,{}, {deletions:['a.md','b.md'],bulkDelete:true});assert.equal(f.files.data.size,0);
    f.files.set('a.md','a');await f.engine.upload(await f.engine.review(),['a.md'],'add');await f.files.remove('a.md');const review=await f.engine.review();
    await assert.rejects(f.engine.upload(review,['a.md'],'remove'),/删除|delet/);
    await f.engine.upload(review,['a.md'],'remove',{deletions:['a.md'],bulkDelete:false});assert.equal((await f.engine.review()).changes.length,0);
  });
  it('rejects stale remote review and concurrent ref races, keeping drafts',async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','local');let review=await f.engine.review();f.advance({'other.md':'remote'});
    await assert.rejects(f.engine.upload(review,['first.md'],'local'),/远端|remote/);assert.equal(f.files.text('first.md'),'local');
    await f.engine.applyPull(await f.engine.planPull());review=await f.engine.review();f.controls.raceBeforeRef=true;
    await assert.rejects(f.engine.upload(review,['first.md'],'race'),/远端|remote|失败/);assert.equal(f.files.text('first.md'),'local');
    await f.engine.applyPull(await f.engine.planPull());assert.equal((await f.engine.status()).pendingUpload,false);
    await f.engine.upload(await f.engine.review(),['first.md'],'retry after review');assert.equal(f.run(['show',`${f.current()}:first.md`]),'local');
  });
  it('persists a created commit and reconciles timeout after successful ref update without duplicate commit',async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','local');const review=await f.engine.review();f.controls.timeoutAfterRef=true;
    await assert.rejects(f.engine.upload(review,['first.md'],'once'));assert.equal(f.store.state?.pending?.commit,f.current());
    const count=f.run(['rev-list','--count','main']);const engine=f.make();await engine.upload(review,['first.md'],'once');
    assert.equal(f.run(['rev-list','--count','main']),count);assert.equal((await engine.review()).changes.length,0);
    assert(!JSON.stringify(f.store.state).includes('fixture-only'));
  });
  it('recovers interrupted application and preserves later user edits',async()=>{
    const f=await fixture({'a.md':'a','b.md':'b'});f.files.fail='b.md';await assert.rejects(f.imported());assert(f.store.state?.journal);
    f.files.fail='';f.files.set('a.md','later');const engine=f.make();const result=await engine.recover();assert.deepEqual(result.preserved,['a.md']);
    assert.equal(f.files.text('a.md'),'later');assert.equal(f.files.text('b.md'),'b');assert.equal((await engine.review()).changes[0]?.path,'a.md');
  });
  it('rejects truncated and malformed API data and safely reports credentials/rate/network errors',async()=>{
    const f=await fixture();f.controls.truncated=true;await assert.rejects(f.engine.planPull(),/完整|truncated|截断/);f.controls.truncated=false;
    f.controls.invalid=true;await assert.rejects(f.engine.planPull(),/响应|response/);f.controls.invalid=false;
    for(const status of [401,403,429]){f.controls.status=status;await assert.rejects(f.engine.planPull(),error=>error instanceof Error && !error.message.includes('SHOULD_NOT_LEAK'));}
    f.controls.status=0;f.controls.offline=true;await assert.rejects(f.engine.planPull(),error=>error instanceof Error && !error.message.includes('SHOULD_NOT_LEAK'));
    assert.equal(f.files.data.size,0);
  });
  it('binds persisted state to exactly one repository and branch',async()=>{
    const f=await fixture();await f.imported();assert(f.store.state);f.store.state.branch='other';await assert.rejects(f.make().review(),/绑定|binding/);
  });
  it('blocks symlinks, collisions, unsafe paths, oversized files and upload messages with secrets',async()=>{
    const f=await fixture();await f.imported();f.files.set('First.md','collision');await assert.rejects(f.engine.review(),/冲突|collision/);f.files.data.delete('First.md');
    f.files.links.push('link.md');await assert.rejects(f.engine.review(),/链接|link/);f.files.links=[];
    f.files.set('../outside.md','no');await assert.rejects(f.engine.review(),/路径|path/);f.files.data.delete('../outside.md');
    f.files.data.set('large.md',new Uint8Array(21*1024*1024));assert.equal((await f.engine.review()).changes.find(c=>c.path==='large.md')?.allowed,false);f.files.data.delete('large.md');
    f.files.set('first.md','ok');await assert.rejects(f.engine.upload(await f.engine.review(),['first.md'],'ghp_'+'x'.repeat(30)),/令牌|secret/);
  });
  it('performs a three-way merge of disjoint files without uploading local changes',async()=>{
    const f=await fixture({'a.md':'a','b.md':'b'});await f.imported();f.files.set('a.md','local');f.advance({'b.md':'remote'});
    const plan=await f.engine.planPull();assert.deepEqual(plan.changes.map(change=>[change.path,change.kind]),[['a.md','local'],['b.md','remote']]);
    assert.match(await f.engine.previewPull(plan,'b.md'),/基线\nb[\s\S]*远端\nremote/);
    const count=f.controls.requests.filter(req=>req.method!=='GET').length;await f.engine.applyPull(plan);
    assert.equal(f.files.text('a.md'),'local');assert.equal(f.files.text('b.md'),'remote');
    assert.equal(f.controls.requests.filter(req=>req.method!=='GET').length,count);assert.equal((await f.engine.review()).changes[0]?.path,'a.md');
  });
  it('ignores tampered review and plan payloads; rejects a changed pull baseline or local file',async()=>{
    const f=await fixture();const plan=await f.engine.planPull();plan.head='0'.repeat(40);plan.changes=[];await f.engine.applyPull(plan);assert.equal(f.files.text('first.md'),'one\ntwo\nthree\n');
    f.advance({'first.md':'remote'});const next=await f.engine.planPull();f.files.set('first.md','later');await assert.rejects(f.engine.applyPull(next),/变化/);assert.equal(f.files.text('first.md'),'later');
    f.files.set('extra.md','extra');const review=await f.engine.review();review.changes.push({path:'injected.md',allowed:true,reason:'',digest:'0'.repeat(40),status:'add'});
    await assert.rejects(f.engine.upload(review,['injected.md'],'bad'),/未审阅/);
  });
  it('restores interrupted state finalization without overwriting later secret edits',async()=>{
    const f=await fixture({'a.md':'a','b.md':'b'});f.store.failAt=2;await assert.rejects(f.imported(),/persistence/);assert(f.store.state?.journal);
    f.files.set('a.md','-----BEGIN PRIVATE KEY-----');const engine=f.make();assert.deepEqual((await engine.recover()).preserved,['a.md']);
    assert.equal(f.files.text('a.md'),'-----BEGIN PRIVATE KEY-----');assert.equal(f.files.text('b.md'),'b');assert(!JSON.stringify(f.store.state).includes('PRIVATE KEY'));
    assert.equal((await engine.review()).changes.find(change=>change.path==='a.md')?.allowed,false);
  });
  it('keeps changes made after a timed-out upload as a new local draft',async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','snapshot');const review=await f.engine.review();f.controls.timeoutAfterRef=true;
    await assert.rejects(f.engine.upload(review,['first.md'],'snapshot'));f.files.set('first.md','later');const engine=f.make();
    const writes=f.controls.requests.filter(req=>req.method!=='GET').length;await engine.recover();
    assert.equal(f.controls.requests.filter(req=>req.method!=='GET').length,writes);assert.equal(f.files.text('first.md'),'later');
    assert.equal((await engine.review()).changes[0]?.path,'first.md');
  });
  it('rejects unsafe remote trees and corrupt blob bodies before any local write',async()=>{
    const f=await fixture();
    const treeMutations: ((tree:Record<string,unknown>)=>void)[]=[
      tree=>{(tree.tree as Record<string,unknown>[])[0]!.path='../outside.md';},
      tree=>{(tree.tree as Record<string,unknown>[])[0]!.mode='120000';},
      tree=>{(tree.tree as Record<string,unknown>[])[0]!.type='commit';},
      tree=>{(tree.tree as Record<string,unknown>[])[0]!.size=21*1024*1024;},
      tree=>{(tree.tree as unknown[]).push((tree.tree as unknown[])[0]);},
      tree=>{(tree.tree as unknown[]).push({...((tree.tree as Record<string,unknown>[])[0]!),path:'First.md'});},
    ];
    for(const mutate of treeMutations){f.controls.transform=(path,json)=>{if(path.startsWith('trees/'))mutate(json as Record<string,unknown>);return json;};await assert.rejects(f.engine.planPull());assert.equal(f.files.data.size,0);}
    for(const content of ['!!!!',Buffer.from('bad data').toString('base64')]){
      f.controls.transform=(path,json)=>path.startsWith('blobs/')?{...(json as object),content}:json;
      await assert.rejects(f.engine.planPull(),/编码|校验/);assert.equal(f.files.data.size,0);
    }
    f.controls.transform=undefined;await f.imported();
  });
  it('enforces the 50 MiB operation budget and stores metadata rather than whole-vault bytes',async()=>{
    const f=await fixture();await f.imported();const byte=new Uint8Array(18*1024*1024);f.files.data.set('a.png',byte);f.files.data.set('b.png',byte);f.files.data.set('c.png',byte);
    await assert.rejects(f.engine.review(),/50 MiB/);assert.deepEqual(Object.keys(f.store.state!.baseline['first.md']!).sort(),['sha','size']);
    assert.equal(f.controls.requests.filter(req=>req.method!=='GET').length,0);
  });
  it('reports typed rate limits and never leaks request exceptions or server messages',async()=>{
    const f=await fixture();f.controls.status=429;await assert.rejects(f.client.head(),error=>error instanceof GitHubError && error.status===429 && error.remaining===0 && error.reset===1234 && !error.message.includes('SHOULD_NOT_LEAK'));
    f.controls.status=302;await assert.rejects(f.client.head(),error=>error instanceof GitHubError && [0,302].includes(error.status));
    assert(f.controls.requests.every(request=>request.url.startsWith('https://api.github.com/repos/example/notes/git/')));
  });
  it('allows a single operation at a time',async()=>{
    const f=await fixture();const operation=f.engine.planPull();await assert.rejects(f.engine.status(),/正在进行/);await operation;
  });
  it('retains the original unsynced bytes when a host write was only partially applied',async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','local original draft');f.advance({'first.md':'remote replacement'});
    const plan=await f.engine.planPull();f.files.partial='first.md';await assert.rejects(f.engine.applyPull(plan,{'first.md':'remote'}),/partial host/);
    f.files.partial='';const recovery=await f.make().recover();assert.deepEqual(recovery.preserved,['first.md']);
    assert.equal(f.files.text('first.md'),'re');assert.equal(f.files.text('first.recovery-copy.md'),'local original draft');
  });
  it('never retries a remote ref write from recovery when the head changes during reconciliation',async()=>{
    const f=await fixture();await f.imported();f.files.set('first.md','snapshot');const review=await f.engine.review();f.controls.timeoutAfterRef=true;
    await assert.rejects(f.engine.upload(review,['first.md'],'snapshot'));const pending=f.store.state!.pending!;f.run(['update-ref','refs/heads/main',pending.parent]);
    let lookups=0;f.controls.transform=(path,json)=>path==='ref/heads/main' && lookups++===0 ? {ref:'refs/heads/main',object:{type:'commit',sha:pending.commit}} : json;
    const writes=f.controls.requests.filter(req=>req.method!=='GET').length;await assert.rejects(f.make().recover(),/变化/);
    assert.equal(f.controls.requests.filter(req=>req.method!=='GET').length,writes);assert.equal(f.current(),pending.parent);
  });
  it('rejects empty-directory case, Unicode and file-directory collisions before planning local writes',async()=>{
    for(const [directory,path] of [['Notes','notes/a.md'],['cafe\u0301','caf\u00e9/a.md'],['a.md','a.md']]) {
      const f=await fixture({[path!]:'remote'});f.files.directories.add(directory!);
      await assert.rejects(f.engine.planPull(),/冲突|collision/);assert.equal(f.store.saves,0);assert.equal(f.files.data.size,0);
    }
  });
  it('rechecks directories created after planning before persisting an apply journal',async()=>{
    for(const [directory,path] of [['Notes','notes/a.md'],['cafe\u0301','caf\u00e9/a.md'],['a.md','a.md']]) {
      const f=await fixture({[path!]:'remote'});const plan=await f.engine.planPull();f.files.directories.add(directory!);
      await assert.rejects(f.engine.applyPull(plan),/冲突|collision/);assert.equal(f.store.saves,0);assert.equal(f.store.state,null);assert.equal(f.files.data.size,0);
    }
  });
  it('accepts exact existing directory ancestors and avoids empty directories when naming both copies',async()=>{
    const f=await fixture({'notes/sub/a.md':'base'});f.files.directories.add('notes');f.files.directories.add('notes/sub');await f.imported();
    f.files.set('notes/sub/a.md','local');f.advance({'notes/sub/a.md':'remote'});const plan=await f.engine.planPull();
    f.files.directories.add('notes/sub/a.local-copy.md');await f.engine.applyPull(plan,{'notes/sub/a.md':'both'});
    assert.equal(f.files.text('notes/sub/a.md'),'remote');assert.equal(f.files.text('notes/sub/a.local-copy-1.md'),'local');
  });
  it('checks directories again after asynchronous remote-head verification, before saving a journal',async()=>{
    const f=await fixture({'notes/a.md':'remote'});const plan=await f.engine.planPull();
    f.controls.transform=(path,json)=>{if(path==='ref/heads/main')f.files.directories.add('Notes');return json;};
    await assert.rejects(f.engine.applyPull(plan),/冲突|collision/);assert.equal(f.store.saves,0);assert.equal(f.files.data.size,0);
  });
  it('imports and persists a legal 5 MiB attachment through review, status, restart and recovery',async()=>{
    const bytes=new Uint8Array(5*1024*1024).fill(7);const f=await fixture({'large.png':bytes});await f.imported();
    assert.deepEqual(await f.files.read('large.png'),bytes);bytes[bytes.length-1]=8;f.files.data.set('large.png',bytes);
    const review=await f.engine.review();assert.equal(review.changes[0]?.path,'large.png');
    assert.equal((await f.engine.status()).initialized,true);const restarted=f.make();assert.equal((await restarted.status()).initialized,true);
    assert.deepEqual(await restarted.recover(),{pending:false,preserved:[]});
    assert.equal((await restarted.planPull()).changes[0]?.kind,'local');assert.deepEqual(await f.files.read('large.png'),bytes);
  });
  it('validates base64 characters and padding without accepting malformed encodings',()=>{
    for(const value of ['A','AAA','A===','AA=A','=AAA','AAAA=','AA?A','AAAA====','Zh==','Zm9='])assert.throws(()=>fromBase64(value),/编码/);
    for(const [encoded,expected] of [['',''],['Zg==','f'],['Zm8=','fo'],['Zm9v','foo'],['Z m\n9v\r\t','foo']])assert.equal(decode(fromBase64(encoded!)),expected);
  });
  it('checks the full proposed upload tree against excluded remote paths before the first POST',async()=>{
    for(const [remotePath,localPath] of [['Notes/private.docx','notes/new.md'],['folder','folder/new.md'],['caf\u00e9/private.docx','cafe\u0301/new.md']]) {
      const f=await fixture({[remotePath!]:'excluded remote original'});await f.imported();f.files.directories.clear();f.files.set(localPath!,'new');const review=await f.engine.review();const before=f.current();
      await assert.rejects(f.engine.upload(review,[localPath!],'reviewed'),/冲突|collision/);
      assert.equal(f.controls.requests.filter(request=>request.method==='POST'||request.method==='PATCH').length,0);
      assert.equal(f.current(),before);assert.equal(f.run(['show',`${before}:${remotePath}`]),'excluded remote original');assert.equal(f.files.text(localPath!),'new');
    }
  });
  it('allows uploads beside excluded files when the complete tree has no collision',async()=>{
    const f=await fixture({'Notes/private.docx':'excluded remote original'});await f.imported();f.files.set('Notes/new.md','new');
    await f.engine.upload(await f.engine.review(),['Notes/new.md'],'reviewed');
    assert.equal(f.run(['show',`${f.current()}:Notes/private.docx`]),'excluded remote original');
    assert.equal((await f.client.snapshot()).files['Notes/new.md']?.size,3);
  });
});
