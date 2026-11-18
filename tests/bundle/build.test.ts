import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

test('Android artifact has no native Node imports and starts without process, Buffer or system Git', async () => {
  const script = await readFile(new URL('../../dist/android/main.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../../dist/android/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'wudao-git'); assert.equal(manifest.isDesktopOnly, false);
  assert.doesNotMatch(script, /require\(["'](?:node:|fs["']|child_process|crypto["'])/);
  const commands: { id: string; callback: () => void }[] = [];
  interface Probe {
    onload(): Promise<void>; onunload(): void; run(action: () => Promise<void>): Promise<void>;
    showChanges(): Promise<void>; showPull(): Promise<void>; recover(): Promise<void>;
    repository(): unknown; store(): { load(): Promise<unknown> };
    settings: { uploadEnabled: boolean; secretName: string };
  }
  const module = { exports: {} as { default?: new () => Probe } };
  let saved = 0;
  const views: { view: object }[] = [];
  class TextFileView { async save() { saved++; } }
  class Plugin {
    app = {
      vault: { adapter: { stat: async () => null }, configDir: '.obsidian' },
      workspace: { iterateAllLeaves(callback: (leaf: { view: object }) => void) { views.forEach(callback); } },
      secretStorage: { getSecret() { return 'fixture-only'; } },
    };
    manifest = { ...manifest, dir: '.obsidian/plugins/wudao-git' };
    async loadData() { return {}; }
    addStatusBarItem() { return { setText() {} }; }
    addSettingTab() {}
    addRibbonIcon() {}
    addCommand(command: { id: string; callback: () => void }) { commands.push(command); }
  }
  class PluginSettingTab { constructor(..._args: unknown[]) {} }
  class Notice { constructor(..._args: unknown[]) {} hide() {} }
  let opened = 0;
  class Modal { contentEl = { empty() {} }; open() { opened++; } close() {} }
  const sdk = { Plugin, PluginSettingTab, Notice, Platform: { isAndroidApp: true }, Modal, Setting: class {}, SecretComponent: class {}, TFile: class {}, TextFileView };
  let networkCalls = 0;
  runInNewContext(script, {
    module, exports: module.exports,
    require: (id: string) => { if (id !== 'obsidian') throw new Error('Native module requested: '+id); return sdk; },
    crypto, TextEncoder, TextDecoder, URL, Uint8Array, ArrayBuffer, AbortController, setTimeout, clearTimeout, btoa, atob,
    fetch: async () => { networkCalls++; throw new Error('Unexpected automatic network request'); },
  });
  assert.ok(module.exports.default);
  const plugin = new module.exports.default(); await plugin.onload();
  assert.equal(plugin.settings.uploadEnabled, false);
  assert.deepEqual(commands.map(c => c.id), ['download', 'review-changes', 'recover']);
  assert.equal(networkCalls, 0);
  plugin.onunload();
  views.push({ view: new TextFileView() });
  let invoked = false;
  await plugin.run(async () => { invoked = true; });
  assert.equal(saved, 0, 'a disabled plugin must not save editor buffers');
  assert.equal(invoked, false, 'a disabled plugin must not execute stale callbacks');
  const interrupted = new module.exports.default(); await interrupted.onload();
  const view = new TextFileView();
  view.save = async () => { interrupted.onunload(); };
  views.splice(0, views.length, { view });
  await interrupted.run(async () => { invoked = true; });
  assert.equal(invoked, false, 'stopping during an awaited save must stop the operation');
  views.splice(0);
  const review = { id: 'fixture', head: '', changes: [] };
  const plan = { id: 'fixture', head: '', initial: false, changes: [], deletions: [] };
  const recovery = { pending: true, preserved: [] };
  for (const method of ['showChanges', 'showPull', 'recover'] as const) {
    const active = new module.exports.default(); await active.onload();
    active.settings.secretName = 'fixture';
    const ready = { review: async () => review, planPull: async () => plan, recover: async () => recovery };
    active.repository = () => ready;
    active.store = () => ({ load: async () => ({ pending: { files: {} }, draft: { review } }) });
    const before = opened;
    await active[method]();
    assert.equal(opened, before + 1, `${method} must open a review while the plugin is active`);
    active.onunload();
    const waiting = new module.exports.default(); await waiting.onload();
    waiting.settings.secretName = 'fixture';
    let complete!: (value: unknown) => void;
    const deferred = new Promise<unknown>(resolve => { complete = resolve; });
    const pending = { review: () => deferred, planPull: () => deferred, recover: () => deferred };
    waiting.repository = () => pending;
    waiting.store = () => ({ load: async () => ({ pending: { files: {} }, draft: { review } }) });
    const operation = waiting[method](); waiting.onunload();
    complete(method === 'showChanges' ? review : method === 'showPull' ? plan : recovery);
    await operation;
    assert.equal(opened, before + 1, `${method} must not open after an awaited check outlives the plugin`);
  }
});

test('both packages contain the required plugin files and match release versions', async () => {
  const base = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
  for (const platform of ['macos', 'android']) {
    const manifest = JSON.parse(await readFile(new URL(`../../dist/${platform}/manifest.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.version, base.version);
    assert.equal(manifest.isDesktopOnly, platform === 'macos');
    const zip = new URL(`../../dist/wudao-git-${base.version}-${platform}.zip`, import.meta.url);
    const names = execFileSync('/usr/bin/unzip', ['-Z1', zip.pathname], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(names, ['LICENSE', 'main.js', 'manifest.json', 'styles.css']);
  }
});
