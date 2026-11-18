import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('desktop does not register stale commands or views when disabled during settings migration',async()=>{
  const registrations:string[]=[];
  class Plugin{
    app={workspace:{}};async loadData(){return {};}
    addStatusBarItem(){registrations.push('status');return {setText(){}};}addSettingTab(){registrations.push('settings');}
    addRibbonIcon(){registrations.push('ribbon');}registerView(){registrations.push('view');}addCommand(){registrations.push('command');}
  }
  const sdk={Plugin,ItemView:class {},PluginSettingTab:class {},Modal:class {},TextFileView:class {},FileSystemAdapter:class {},Notice:class {}};
  interface Probe{onload():Promise<void>;onunload():void;settings:{repository:string};storage():unknown}
  const module={exports:{} as {default?:new()=>Probe}};const require=createRequire(import.meta.url);
  runInNewContext(await readFile(new URL('../../dist/macos/main.js',import.meta.url),'utf8'),{
    module,exports:module.exports,require:(id:string)=>{if(id==='obsidian')return sdk;assert.match(id,/^node:/);return require(id);},
  });
  assert.ok(module.exports.default);const plugin=new module.exports.default();
  let finish!:(value:unknown)=>void;let began!:()=>void;const waiting=new Promise<unknown>(resolve=>{finish=resolve;});const entered=new Promise<void>(resolve=>{began=resolve;});
  plugin.storage=()=>({loadSettings:()=>{began();return waiting;}});
  const loading=plugin.onload();await entered;plugin.onunload();finish({repository:'example/notes'});await loading;
  assert.deepEqual(registrations,[]);assert.equal(plugin.settings.repository,'');
});
