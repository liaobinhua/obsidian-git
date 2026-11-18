import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Android applies and reports the same conflict choices when controls change during an awaited write', async () => {
  const nodes: Element[] = []; const notices: string[] = [];
  class Element {
    tag: string; text?: string; value = ''; events: Record<string, () => void> = {};
    constructor(tag: string, options: { text?: string } = {}) { this.tag = tag; this.text = options.text; nodes.push(this); }
    createEl(tag: string, options?: { text?: string }) { return new Element(tag, options); }
    createDiv(options?: { text?: string }) { return this.createEl('div', options); }
    createSpan(options?: { text?: string }) { return this.createEl('span', options); }
    addClass() {} empty() {}
    addEventListener(event: string, callback: () => void) { this.events[event] = callback; }
  }
  class Modal {
    contentEl = new Element('root');
    onOpen?(): void; onClose?(): void;
    setTitle() {} open() { this.onOpen?.(); } close() { this.onClose?.(); }
  }
  class Plugin {
    app = {
      vault: { adapter: { stat: async () => null }, configDir: '.obsidian' },
      workspace: { iterateAllLeaves() {} }, secretStorage: { getSecret: () => 'fixture' },
    };
    manifest = { id: 'wudao-git', dir: '.obsidian/plugins/wudao-git' };
    async loadData() { return {}; }
    addStatusBarItem() { return { setText() {} }; }
    addSettingTab() {} addRibbonIcon() {} addCommand() {}
    registerView() {}
  }
  class Notice { constructor(message: string) { notices.push(message); } hide() {} }
  const sdk = { Plugin, ItemView:class {}, Modal, Notice, PluginSettingTab: class {}, Platform: { isAndroidApp: true }, TextFileView: class {}, TFile: class {} };
  interface Probe {
    onload(): Promise<void>; onunload(): void; showPull(): Promise<void>;
    settings: { secretName: string }; repository(): unknown;
  }
  const module = { exports: {} as { default?: new () => Probe } };
  runInNewContext(await readFile(new URL('../../dist/android/main.js', import.meta.url), 'utf8'), {
    module, exports: module.exports,
    require: (id: string) => { assert.equal(id, 'obsidian'); return sdk; },
    crypto, TextEncoder, TextDecoder, URL, Uint8Array, ArrayBuffer, AbortController, setTimeout, clearTimeout, btoa, atob,
  });
  assert.ok(module.exports.default);
  const plugin = new module.exports.default(); await plugin.onload(); plugin.settings.secretName = 'fixture';
  let release!: (result: { preserved: string[] }) => void; let applied!: Record<string, string>;
  let began!:()=>void;const applying=new Promise<void>(resolve=>{began=resolve;});
  const engine = {
    inspectVault:async()=>({initialized:true}),
    planPull: async () => ({
      id: 'review', head: 'a'.repeat(40), initial: false, directories: [], deletions: [],
      summary: { remoteFiles: 1, remoteDirectories: 0, managedFiles: 1, excluded: [] },
      changes: [{ path: 'note.md', kind: 'conflict', deleted: false }],
    }),
    applyPull: async (_plan: unknown, choices: Record<string, string>) => {
      applied = choices; return new Promise<{ preserved: string[] }>(resolve => { release = resolve;began(); });
    },
  };
  plugin.repository = () => engine; await plugin.showPull();
  const select = nodes.find(node => node.tag === 'select'); assert.ok(select);
  select.value = 'remote'; select.events.change!();
  const button = nodes.find(node => node.tag === 'button' && node.text === '应用已检查的更新'); assert.ok(button);
  button.events.click!();
  select.value = 'local'; select.events.change!();
  await applying;
  assert.equal(applied['note.md'], 'remote', 'later UI input must not mutate the approved application snapshot');
  release({ preserved: [] }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(notices.at(-1)!, /下载或更新 1 个文件/);
  plugin.onunload();
});
