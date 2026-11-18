import { allowedPath, checkBytes, validPath } from './mobile/policy.ts';
import type { LocalFiles, MobileState, RequestPort, StateStore } from './mobile/types.ts';

export interface HostAdapter {
  stat(path: string): Promise<{ type: 'file' | 'folder'; size: number; mtime?: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

async function directory(adapter: HostAdapter, path: string, create: boolean, mkdir?: (path: string) => Promise<void>): Promise<boolean> {
  if (!validPath(path)) throw new Error('目录路径无效。');
  let current = '';
  for (const part of path.split('/')) {
    current = current ? `${current}/${part}` : part;
    const stat = await adapter.stat(current);
    if (!stat) { if (!create) return false; if (mkdir) await mkdir(current); else await adapter.mkdir(current); }
    else if (stat.type !== 'folder') throw new Error('父目录包含文件，无法安全访问。');
  }
  return true;
}

interface FileActions {
  mkdir?: (path: string) => Promise<void>;
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
  remove?: (path: string) => Promise<void>;
}

export class MobileFiles implements LocalFiles {
  private adapter: HostAdapter;
  private actions: FileActions;
  constructor(adapter: HostAdapter, actions: FileActions = {}) { this.adapter = adapter; this.actions = actions; }

  async list(): ReturnType<LocalFiles['list']> {
    const result: Awaited<ReturnType<LocalFiles['list']>> = [];
    const pending = ['']; const seen = new Set<string>();
    while (pending.length) {
      const parent = pending.pop()!;
      if (seen.has(parent) || parent.split('/').length > 64) throw new Error('目录结构包含循环或层级过深。');
      seen.add(parent);
      const listing = await this.adapter.list(parent);
      for (const [kind, entries] of [['file', listing.files], ['directory', listing.folders]] as const) {
        for (const path of entries) {
          if (!validPath(path) || path.slice(0, path.lastIndexOf('/') + 1) !== (parent ? parent + '/' : '')) throw new Error('目录返回了文库外部或非直接子项路径。');
          if (path.split('/').some(part => part.startsWith('.'))) continue;
          const stat = await this.adapter.stat(path);
          if (!stat || stat.type !== (kind === 'file' ? 'file' : 'folder')) throw new Error('目录扫描期间文件类型发生变化。');
          result.push({ path, kind });
          if (result.length > 100000) throw new Error('文库文件过多，无法安全扫描。');
          if (kind === 'directory') pending.push(path);
        }
      }
    }
    return result;
  }

  private async parent(path: string, create: boolean): Promise<boolean> {
    if (!allowedPath(path)) throw new Error('文件路径不在允许同步的范围。');
    const slash = path.lastIndexOf('/');
    return slash < 0 || await directory(this.adapter, path.slice(0, slash), create, this.actions.mkdir);
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (!await this.parent(path, false)) return null;
    const before = await this.adapter.stat(path);
    if (!before) return null;
    if (before.type !== 'file' || before.size > 20 * 1024 * 1024) throw new Error('仅支持不超过 20 MiB 的普通文件。');
    const bytes = new Uint8Array(await this.adapter.readBinary(path));
    const after = await this.adapter.stat(path);
    if (!after || after.type !== 'file' || before.size !== after.size || before.mtime !== after.mtime || bytes.length !== after.size) throw new Error('文件读取期间发生变化。');
    return bytes;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    checkBytes(bytes);
    await this.parent(path, true);
    const current = await this.adapter.stat(path);
    if (current && current.type !== 'file') throw new Error('写入目标不是普通文件。');
    if (this.actions.write) await this.actions.write(path, bytes);
    else await this.adapter.writeBinary(path, Uint8Array.from(bytes).buffer);
  }

  async remove(path: string): Promise<void> {
    if (!await this.parent(path, false)) return;
    const current = await this.adapter.stat(path);
    if (!current) return;
    if (current.type !== 'file') throw new Error('删除目标不是普通文件。');
    if (this.actions.remove) await this.actions.remove(path); else await this.adapter.remove(path);
  }
}

interface Envelope { version: 1; sequence: number; checksum: string; payload: string }
class StateCorruption extends Error { constructor() { super('本地同步记录损坏或写入校验失败，请保留文档并检查状态备份。'); } }
function parse(value: string): unknown { try { return JSON.parse(value); } catch { throw new StateCorruption(); } }
const MAX_STATE_BYTES = 80 * 1024 * 1024;
async function checksum(payload: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class RotatingStateStore implements StateStore {
  private adapter: HostAdapter;
  private root: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(adapter: HostAdapter, root: string) {
    if (!validPath(root)) throw new Error('本地同步状态目录无效。');
    this.adapter = adapter; this.root = root;
  }

  private async envelope(path: string): Promise<Envelope | null> {
    const stat = await this.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== 'file' || stat.size > MAX_STATE_BYTES) throw new StateCorruption();
    const raw = parse(await this.adapter.read(path));
    if (!raw || typeof raw !== 'object') throw new StateCorruption();
    const value = raw as Partial<Envelope>;
    if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence! < 1 || typeof value.payload !== 'string' || typeof value.checksum !== 'string' || await checksum(value.payload) !== value.checksum) throw new StateCorruption();
    const state = parse(value.payload);
    if (!state || typeof state !== 'object' || !('version' in state) || state.version !== 1) throw new StateCorruption();
    return value as Envelope;
  }

  private async latest(): Promise<Envelope | null> {
    const candidates: Envelope[] = []; let found = false;
    for (const slot of ['a', 'b']) {
      const path = `${this.root}/mobile-state-${slot}.json`;
      if (!await this.adapter.stat(path)) continue;
      found = true;
      try { const entry = await this.envelope(path); if (entry) candidates.push(entry); }
      catch (error) { if (!(error instanceof StateCorruption)) throw error; }
    }
    candidates.sort((a,b) => b.sequence - a.sequence);
    if (found && !candidates.length) throw new Error('本地同步记录损坏，请保留文档并检查状态备份。');
    if (candidates.length === 2 && candidates[0]!.sequence === candidates[1]!.sequence && candidates[0]!.checksum !== candidates[1]!.checksum) throw new Error('同步记录的两个版本不一致，请保留备份。');
    return candidates[0] ?? null;
  }

  async load(): Promise<MobileState | null> {
    await this.tail;
    const envelope = await this.latest();
    return envelope ? JSON.parse(envelope.payload) as MobileState : null;
  }

  async save(state: MobileState): Promise<void> {
    const action = this.tail.then(async () => {
      const previous = await this.latest();
      const sequence = (previous?.sequence ?? 0) + 1;
      const payload = JSON.stringify(state);
      if (new TextEncoder().encode(payload).length > MAX_STATE_BYTES - 1024) throw new Error('同步暂存数据过大，请分批处理。');
      const entry: Envelope = { version: 1, sequence, checksum: await checksum(payload), payload };
      const path = `${this.root}/mobile-state-${sequence % 2 ? 'a' : 'b'}.json`;
      const temp = `${path}.tmp`;
      await directory(this.adapter, this.root, true);
      await this.adapter.write(temp, JSON.stringify(entry));
      if ((await this.envelope(temp))?.checksum !== entry.checksum) throw new Error('同步记录写入校验失败。');
      if (await this.adapter.stat(path)) await this.adapter.remove(path);
      await this.adapter.rename(temp, path);
      if ((await this.envelope(path))?.checksum !== entry.checksum) throw new Error('同步记录最终写入校验失败。');
    });
    this.tail = action.catch(() => undefined);
    await action;
  }
}

export function restrictedRequest(request: RequestPort, canUpload: () => boolean): RequestPort {
  return async options => {
    if (!canUpload() && options.method !== 'GET') throw new Error('当前仅允许下载，请先启用上传。');
    return request(options);
  };
}

export function createRequest(fetcher: typeof fetch = globalThis.fetch, lifetime?: AbortSignal): RequestPort {
  return async options => {
    const url = new URL(options.url);
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) throw new Error('仅允许固定的 GitHub API 地址。');
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    if (lifetime?.aborted) controller.abort();
    lifetime?.addEventListener('abort', abort);
    const timer = setTimeout(() => { controller.abort(); }, 60000);
    try {
      const response = await fetcher(url.href, {
        method: options.method, headers: options.headers, body: options.body,
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 40 * 1024 * 1024) throw new Error('GitHub 响应过大。');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) {
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            size += item.value.length;
            if (size > 40 * 1024 * 1024) throw new Error('GitHub 响应过大。');
            chunks.push(item.value);
          }
        } catch (error) { await reader.cancel(); throw error; }
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder().decode(bytes);
      let json: unknown = null;
      if (text) { try { json = JSON.parse(text); } catch { throw new Error('GitHub 响应格式无效。'); } }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), json };
    } catch { controller.abort(); throw new Error('GitHub 网络请求未完成，请检查网络后重试；本地内容已保留。'); }
    finally { clearTimeout(timer); lifetime?.removeEventListener('abort', abort); }
  };
}
