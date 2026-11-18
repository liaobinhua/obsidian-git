import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, lstat, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultPersistence } from '../src/persistence.ts';
import { RotatingStateStore, type HostAdapter } from '../src/mobile-host.ts';
import type { MobileState } from '../src/mobile/types.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wudao-persistence-')); roots.push(root);
  const adapter: HostAdapter = {
    async stat(path) { try { const stat = await lstat(join(root,path)); if(stat.isSymbolicLink())throw new Error('symlink');return {type:stat.isDirectory()?'folder':'file',size:stat.size,mtime:stat.mtimeMs}; }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;} },
    async list(path) { const entries = await readdir(join(root,path),{withFileTypes:true});return {files:entries.filter(e=>!e.isDirectory()).map(e=>path+'/'+e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>path+'/'+e.name)}; },
    async read(path) { return readFile(join(root,path),'utf8'); },async write(path,value) { await writeFile(join(root,path),value); },
    async readBinary(path) { return Uint8Array.from(await readFile(join(root,path))).buffer; },async writeBinary(path,value) { await writeFile(join(root,path),new Uint8Array(value)); },
    async mkdir(path) { await mkdir(join(root,path)); },async rename(from,to) { await rename(join(root,from),join(root,to)); },async remove(path) { await rm(join(root,path)); },
  };
  const legacy='.obsidian/plugins/wudao-git';const durable='.obsidian/wudao-git';
  const persistence=()=>new VaultPersistence(adapter,'.obsidian',legacy);
  const state:MobileState={version:1,repository:'example/notes',branch:'main',head:'a'.repeat(40),baseline:{}};
  return {root,adapter,legacy,durable,persistence,state};
}
test('migrates complete schema 1 state and settings outside the replaceable plugin directory',async()=>{
  const f=await fixture();const legacy=new RotatingStateStore(f.adapter,f.legacy);
  f.state.draft={review:{id:'old',head:f.state.head,changes:[]},files:{}};
  f.state.pending={commit:'b'.repeat(40),parent:f.state.head,files:{}};
  f.state.journal={head:f.state.head,baseline:{},entries:[],directories:['notes']};
  await legacy.save(f.state);const old=await f.adapter.read(f.legacy+'/mobile-state-a.json');
  const settings={repository:'example/notes',branch:'main',secretName:'phone-reference',uploadEnabled:true};
  assert.deepEqual(await f.persistence().loadSettings(settings),settings);assert.deepEqual(await f.persistence().state().load(),f.state);
  assert.equal(await f.adapter.read(f.legacy+'/mobile-state-a.json'),old);
  await rm(join(f.root,f.legacy),{recursive:true,force:true});
  assert.deepEqual(await f.persistence().loadSettings({}),settings);assert.deepEqual(await f.persistence().state().load(),f.state);
});
test('recovers repository binding from a migrated state when plugin settings are missing',async()=>{
  const f=await fixture();await new RotatingStateStore(f.adapter,f.legacy).save(f.state);
  assert.deepEqual(await f.persistence().loadSettings({}),{repository:'example/notes',branch:'main'});
});
test('does not fall back to stale plugin records when durable copies are corrupt or from a newer format',async()=>{
  const f=await fixture();await new RotatingStateStore(f.adapter,f.legacy).save(f.state);await f.persistence().state().load();
  await f.adapter.write(f.durable+'/mobile-state-a.json','broken');
  await assert.rejects(f.persistence().state().load(),/损坏/);
  await f.adapter.write(f.durable+'/mobile-state-a.json',JSON.stringify({version:9}));
  await assert.rejects(f.persistence().state().load(),/版本|格式/);
  await assert.rejects(f.persistence().state().prepareRepair!(),/版本|格式/);
});
test('explicit repair preserves raw corrupt state and refuses a changed repair preview',async()=>{
  const f=await fixture();await new RotatingStateStore(f.adapter,f.legacy).save(f.state);await f.persistence().state().load();
  const path=f.durable+'/mobile-state-a.json';await f.adapter.write(path,'original broken record');
  const state=f.persistence().state();const token=await state.prepareRepair!('example/notes','main');
  await f.adapter.write(path,'later broken record');await assert.rejects(state.repair!(token,f.state),/变化/);
  const latest=await state.prepareRepair!('example/notes','main');await state.repair!(latest,f.state);
  assert.equal(await f.adapter.read(path),'later broken record');assert.deepEqual(await f.persistence().state().load(),f.state);
  const listing=await f.adapter.list(f.durable);assert(listing.folders.some(path=>path.includes('rebuild-')));
});
test('settings store accepts references but rejects token values and persists only approved fields',async()=>{
  const f=await fixture();const persistence=f.persistence();
  await assert.rejects(persistence.saveSettings({repository:'example/notes',secretName:'ghp_'+'x'.repeat(40)}),/引用/);
  await persistence.saveSettings({repository:'example/notes',secretName:'phone-reference',ignored:'not persisted'});
  assert.deepEqual(await f.persistence().loadSettings({repository:'old/repo'}),{repository:'example/notes',secretName:'phone-reference'});
});
