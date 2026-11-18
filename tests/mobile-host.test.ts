import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, lstat, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileFiles, RotatingStateStore, createRequest, restrictedRequest, type HostAdapter } from '../src/mobile-host.ts';
import type { MobileState } from '../src/mobile/types.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function host(): Promise<{ root: string; adapter: HostAdapter }> {
  const root = await mkdtemp(join(tmpdir(), 'wudao-host-')); roots.push(root);
  const adapter: HostAdapter = {
    async stat(path) {
      try {
        const stat = await lstat(join(root, path));
        if (stat.isSymbolicLink()) throw new Error('symlink');
        return { type: stat.isDirectory() ? 'folder' : 'file', size: stat.size, mtime: stat.mtimeMs };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async list(path) {
      const entries = await readdir(join(root, path), { withFileTypes: true });
      return { files: entries.filter(e => !e.isDirectory()).map(e => path ? path+'/'+e.name : e.name), folders: entries.filter(e => e.isDirectory()).map(e => path ? path+'/'+e.name : e.name) };
    },
    async readBinary(path) { const bytes = await readFile(join(root, path)); return Uint8Array.from(bytes).buffer; },
    async writeBinary(path, bytes) { await writeFile(join(root, path), new Uint8Array(bytes)); },
    async read(path) { return readFile(join(root, path), 'utf8'); },
    async write(path, data) { await writeFile(join(root, path), data); },
    async mkdir(path) { await mkdir(join(root, path)); },
    async rename(from, to) { await rename(join(root, from), join(root, to)); },
    async remove(path) { await rm(join(root, path)); },
  };
  return { root, adapter };
}
const state = (head: string): MobileState => ({ version: 1, repository: 'example/notes', branch: 'main', head, baseline: {} });

test('mobile vault adapter handles ordinary documents and excludes internal folders', async () => {
  const { root, adapter } = await host(); const files = new MobileFiles(adapter);
  await mkdir(join(root, '.obsidian')); await writeFile(join(root, '.obsidian', 'private.json'), '{}');
  await files.write('感悟/第一篇.md', new TextEncoder().encode('正文'));
  assert.equal(new TextDecoder().decode((await files.read('感悟/第一篇.md'))!), '正文');
  assert.deepEqual((await files.list()).filter(e => e.kind === 'file').map(e => e.path), ['感悟/第一篇.md']);
  await files.remove('感悟/第一篇.md');
  assert.equal(await files.read('感悟/第一篇.md'), null);
  await assert.rejects(files.read('../private.md'), /路径|范围/);
  await files.mkdir('空分类/子分类'); await files.mkdir('空分类/子分类');
  assert.equal((await adapter.stat('空分类/子分类'))?.type, 'folder');
  await assert.rejects(files.mkdir('.obsidian/unsafe'), /目录|范围/);
  await files.write('file.md', new TextEncoder().encode('keep'));
  await assert.rejects(files.mkdir('file.md'), /目录/);
  assert.equal(new TextDecoder().decode((await files.read('file.md'))!), 'keep');
});

test('adapter rejects malformed directory listings and propagates unreadable errors', async () => {
  const { adapter } = await host();
  const escape = new MobileFiles({ ...adapter, list: async () => ({ files: ['../private.md'], folders: [] }) });
  await assert.rejects(escape.list(), /路径|目录/);
  const denied = new MobileFiles({ ...adapter, stat: async () => { throw new Error('permission denied'); } });
  await assert.rejects(denied.read('note.md'), /permission denied/);
});

test('raw recovery reads retain later private edits while new writes still enforce content policy', async () => {
  const { root, adapter } = await host(); const files = new MobileFiles(adapter);
  const text = '-----BEGIN PRIVATE KEY-----\nuser edit';
  await writeFile(join(root, 'note.md'), text);
  assert.equal(new TextDecoder().decode((await files.read('note.md'))!), text);
  await assert.rejects(files.write('copy.md', new TextEncoder().encode(text)), /令牌|私钥/);
});

test('vault callbacks create indexed folders before writing documents', async () => {
  const { adapter } = await host(); const calls: string[] = [];
  const files = new MobileFiles(adapter, {
    mkdir: async path => { calls.push('folder:'+path); await adapter.mkdir(path); },
    write: async (path, bytes) => { calls.push('file:'+path); await adapter.writeBinary(path, Uint8Array.from(bytes).buffer); },
    remove: async path => { calls.push('trash:'+path); await adapter.remove(path); },
  });
  await files.write('notes/sub/note.md', new TextEncoder().encode('safe'));
  await files.remove('notes/sub/note.md');
  assert.deepEqual(calls, ['folder:notes','folder:notes/sub','file:notes/sub/note.md','trash:notes/sub/note.md']);
});

test('rotating state survives an interrupted replacement and refuses corrupt state', async () => {
  const { adapter } = await host(); const directory = '.obsidian/plugins/wudao-git';
  const store = new RotatingStateStore(adapter, directory);
  assert.equal(await store.load(), null);
  await store.save(state('1'.repeat(40)));
  await store.save(state('2'.repeat(40)));
  assert.equal((await store.load())?.head, '2'.repeat(40));
  const broken = new RotatingStateStore({ ...adapter, rename: async () => { throw new Error('interrupted'); } }, directory);
  await assert.rejects(broken.save(state('3'.repeat(40))), /interrupted/);
  assert.equal((await new RotatingStateStore(adapter, directory).load())?.head, '2'.repeat(40));
  const all = await adapter.list(directory);
  for (const file of all.files) await adapter.write(file, 'corrupt');
  await assert.rejects(new RotatingStateStore(adapter, directory).load(), /损坏|不完整/);
});

test('rotating state verifies writes and retains a previous valid generation', async () => {
  const { adapter } = await host(); const directory = '.obsidian/plugins/wudao-git';
  const store = new RotatingStateStore(adapter, directory);
  await store.save(state('a'.repeat(40)));
  const broken = new RotatingStateStore({ ...adapter, write: async (path) => { await adapter.write(path, 'bad'); } }, directory);
  await assert.rejects(broken.save(state('b'.repeat(40))), /校验|损坏|写入/);
  assert.equal((await store.load())?.head, 'a'.repeat(40));
});

test('HTTP transport never follows a redirect or sends a token to a foreign origin', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/stolen' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const localFetch: typeof fetch = (input, init) => fetch(`http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`, init);
    const request = createRequest(localFetch);
    const response = await request({ url: 'https://api.github.com/ok', method: 'GET', headers: { Authorization: 'Bearer test-only' } });
    assert.deepEqual(response.json, { ok: true });
    let enabled = false;
    const guarded = restrictedRequest(request, () => enabled);
    const reads = calls;
    await assert.rejects(guarded({ url: 'https://api.github.com/ok', method: 'POST', headers: {} }), /下载|上传/);
    assert.equal(calls, reads);
    enabled = true;
    await guarded({ url: 'https://api.github.com/ok', method: 'POST', headers: {} });
    const lifetime = new AbortController(); lifetime.abort();
    await assert.rejects(createRequest(localFetch, lifetime.signal)({ url: 'https://api.github.com/ok', method: 'GET', headers: {} }), /网络|请求/);
    await assert.rejects(request({ url: 'https://api.github.com/redirect', method: 'GET', headers: { Authorization: 'Bearer test-only' } }), /网络|请求/);
    const before = calls;
    await assert.rejects(request({ url: 'https://example.invalid/stolen', method: 'GET', headers: { Authorization: 'Bearer test-only' } }), /GitHub|地址/);
    assert.equal(calls, before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); }); }
});
