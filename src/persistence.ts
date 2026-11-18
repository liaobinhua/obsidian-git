import { RotatingStateStore, StateCorruption, StateVersionError, type HostAdapter } from './mobile-host.ts';
import { binding, validPath } from './mobile/policy.ts';
import type { MobileState, StateStore } from './mobile/types.ts';

async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function ensure(adapter: HostAdapter, path: string): Promise<void> {
  let current = '';
  for (const part of path.split('/')) {
    current = current ? current+'/'+part : part; const stat = await adapter.stat(current);
    if (!stat) await adapter.mkdir(current);
    else if (stat.type !== 'folder') throw new Error('同步记录目录被普通文件占用。');
  }
}
interface Envelope { version: 1; sequence: number; checksum: string; payload: string }
class JsonStore {
  private adapter: HostAdapter; private root: string; private name: string;
  constructor(adapter: HostAdapter, root: string, name: string) { this.adapter = adapter; this.root = root; this.name = name; }
  private async latest(): Promise<Envelope | null> {
    const entries: Envelope[] = []; let found = false;
    for (const slot of ['a','b']) {
      const path = `${this.root}/${this.name}-${slot}.json`; const stat = await this.adapter.stat(path);
      if (!stat) continue; found = true;
      if (stat.type !== 'file' || stat.size > 1024*1024) throw new StateCorruption();
      const text = await this.adapter.read(path); let value: Partial<Envelope>;
      try { value = JSON.parse(text) as Partial<Envelope>; } catch { continue; }
      if (!value || typeof value !== 'object') continue;
      if (!('version' in value)) continue;
      if (value.version !== 1) throw new StateVersionError();
      if (!Number.isSafeInteger(value.sequence) || value.sequence! < 1 || typeof value.payload !== 'string' || typeof value.checksum !== 'string' || await hash(value.payload) !== value.checksum) continue;
      try { JSON.parse(value.payload); } catch { continue; }
      entries.push(value as Envelope);
    }
    entries.sort((a,b) => b.sequence-a.sequence);
    if (found && !entries.length || entries.length === 2 && entries[0]!.sequence === entries[1]!.sequence && entries[0]!.checksum !== entries[1]!.checksum) throw new StateCorruption();
    return entries[0] ?? null;
  }
  async read(): Promise<unknown | null> { const entry = await this.latest(); return entry ? JSON.parse(entry.payload) : null; }
  async save(value: unknown): Promise<void> {
    const previous = await this.latest(); const sequence = (previous?.sequence ?? 0)+1; const payload = JSON.stringify(value);
    if (new TextEncoder().encode(payload).length > 1024*1024-1024) throw new Error('同步设置过大。');
    const entry: Envelope = {version:1,sequence,checksum:await hash(payload),payload};
    await ensure(this.adapter,this.root); const path = `${this.root}/${this.name}-${sequence%2?'a':'b'}.json`; const temp = path+'.tmp';
    const text = JSON.stringify(entry); await this.adapter.write(temp,text);
    if (await this.adapter.read(temp) !== text) throw new StateCorruption();
    if (await this.adapter.stat(path)) await this.adapter.remove(path);
    await this.adapter.rename(temp,path);
    if ((await this.latest())?.checksum !== entry.checksum) throw new StateCorruption();
  }
}
function settings(value: unknown): Record<string, string | boolean> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('本地仓库设置格式无效。');
  const source = value as Record<string, unknown>; const result: Record<string,string|boolean> = {};
  for (const key of ['repository','branch','secretName'] as const) {
    if (!(key in source)) continue;
    if (typeof source[key] !== 'string') throw new Error('本地仓库设置格式无效。');
    result[key] = source[key];
  }
  if ('uploadEnabled' in source) { if (typeof source.uploadEnabled !== 'boolean') throw new Error('上传模式无效。'); result.uploadEnabled = source.uploadEnabled; }
  if (result.secretName && !/^[a-z0-9-]+$/.test(String(result.secretName))) throw new Error('密钥设置只接受本机引用名称，不接受令牌值。');
  if (result.repository) binding(String(result.repository),String(result.branch || 'main'));
  return result;
}
interface RecordDigest { path: string; digest: string }

/** Vault-owned state survives replacement or removal of the plugin program folder. */
export class VaultPersistence {
  readonly root: string;
  private adapter: HostAdapter; private legacy: string; private config: JsonStore; private location: JsonStore;
  private tail: Promise<unknown> = Promise.resolve(); private port: StateStore;
  constructor(adapter: HostAdapter, configDir: string, legacyPluginDir: string) {
    if (!validPath(configDir) || !validPath(legacyPluginDir)) throw new Error('同步设置目录无效。');
    this.adapter = adapter; this.root = configDir+'/wudao-git'; this.legacy = legacyPluginDir;
    this.config = new JsonStore(adapter,this.root,'settings'); this.location = new JsonStore(adapter,this.root,'state-location');
    this.port = {
      load: () => this.serial(() => this.loadState()), save: state => this.serial(async () => { await this.loadState(); await new RotatingStateStore(adapter,await this.active()).save(state); }),
      prepareRepair: (repository,branch) => this.serial(() => this.repairToken(repository,branch)),
      repair: (expected,state) => this.serial(() => this.replace(expected,state)),
    };
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action); this.tail = next.catch(() => undefined); return next;
  }
  async loadSettings(legacy: unknown): Promise<Record<string,string|boolean>> {
    return this.serial(async () => {
      const current = await this.config.read(); if (current !== null) return settings(current);
      const migrated = settings(legacy);
      if (!migrated.repository) {
        const state = await this.loadState(); if (state) { migrated.repository = state.repository; migrated.branch = state.branch; }
      }
      if (Object.keys(migrated).length) await this.config.save(migrated);
      return migrated;
    });
  }
  async saveSettings(value: unknown): Promise<void> { return this.serial(async () => { await this.config.save(settings(value)); }); }
  state(): StateStore { return this.port; }
  private async active(): Promise<string> {
    const value = await this.location.read(); if (value === null) return this.root;
    if (!value || typeof value !== 'object' || !('directory' in value) || typeof value.directory !== 'string' || !/^rebuild-[0-9a-f-]{36}$/.test(value.directory)) throw new StateCorruption();
    return this.root+'/'+value.directory;
  }
  private async loadState(): Promise<MobileState | null> {
    const active = await this.active(); const store = new RotatingStateStore(this.adapter,active); const state = await store.load();
    if (state) return state;
    if (active !== this.root) throw new StateCorruption();
    const legacy = await new RotatingStateStore(this.adapter,this.legacy).load(); if (!legacy) return null;
    await store.save(legacy);
    if (JSON.stringify(await store.load()) !== JSON.stringify(legacy)) throw new StateCorruption();
    return legacy;
  }
  private async records(): Promise<RecordDigest[]> {
    const roots = new Set([this.root,this.legacy]); const stat = await this.adapter.stat(this.root);
    if (stat && stat.type !== 'folder') throw new StateCorruption();
    if (stat) for (const folder of (await this.adapter.list(this.root)).folders) {
      if (folder.slice(0,folder.lastIndexOf('/')) !== this.root) throw new StateCorruption();
      if (/^rebuild-[0-9a-f-]{36}$/.test(folder.slice(folder.lastIndexOf('/')+1))) roots.add(folder);
      if (roots.size > 100) throw new Error('恢复记录过多，请先保留文库备份并检查。');
    }
    const paths = [...roots].flatMap(root => ['a','b'].flatMap(slot => [`${root}/mobile-state-${slot}.json`,`${root}/mobile-state-${slot}.json.tmp`]));
    paths.push(...['a','b'].map(slot => `${this.root}/state-location-${slot}.json`));
    const records: RecordDigest[] = [];
    for (const path of paths.sort()) {
      const entry = await this.adapter.stat(path); if (!entry) continue;
      if (entry.type !== 'file' || entry.size > 80*1024*1024) throw new StateCorruption();
      const raw = await this.adapter.read(path); let envelope: Record<string,unknown> | null = null;
      try { envelope = JSON.parse(raw) as Record<string,unknown>; } catch { /* Raw corrupt records are preserved verbatim. */ }
      if (envelope && typeof envelope === 'object' && 'version' in envelope && envelope.version !== 1) throw new StateVersionError();
      if (typeof envelope?.payload === 'string') {
        let payload: Record<string,unknown> | null = null;
        try { payload = JSON.parse(envelope.payload) as Record<string,unknown>; } catch { /* Preserve corrupt payload verbatim. */ }
        if (payload && typeof payload === 'object' && 'version' in payload && payload.version !== 1) throw new StateVersionError();
      }
      records.push({path,digest:await hash(raw)});
    }
    return records;
  }
  private async repairToken(repository?: string, branch?: string): Promise<string> {
    try {
      const state = await this.loadState();
      if (state && (repository && state.repository !== repository || branch && state.branch !== branch)) throw new Error('同步记录绑定其他仓库或分支，不能作为损坏记录重建。');
    } catch (error) { if (!(error instanceof StateCorruption)) throw error; }
    const records = await this.records(); if (!records.length) throw new Error('没有需要修复的同步记录，请直接连接现有文库。');
    return hash(JSON.stringify(records));
  }
  private async replace(expected: string, state: MobileState): Promise<void> {
    if (await this.repairToken(state.repository,state.branch) !== expected) throw new Error('同步记录在预览后发生变化，请重新检查修复。');
    const records = await this.records(); const directory = 'rebuild-'+crypto.randomUUID(); const target = this.root+'/'+directory;
    await ensure(this.adapter,target+'/originals');
    for (let i=0;i<records.length;i++) {
      const record = records[i]!; const raw = await this.adapter.read(record.path);
      if (await hash(raw) !== record.digest) throw new Error('同步记录在备份期间发生变化，请重新检查。');
      const path = `${target}/originals/${i}.json`; await this.adapter.write(path,raw);
      if (await hash(await this.adapter.read(path)) !== record.digest) throw new StateCorruption();
    }
    const inventory = JSON.stringify(records); await this.adapter.write(target+'/originals/paths.json',inventory);
    if (await this.adapter.read(target+'/originals/paths.json') !== inventory) throw new StateCorruption();
    await new RotatingStateStore(this.adapter,target).save(state);
    // Compare original paths again without including our unpublished generation.
    for (const record of records) if (await hash(await this.adapter.read(record.path)) !== record.digest) throw new Error('同步记录在修复期间发生变化，请重新检查。');
    await this.location.save({directory});
  }
}
