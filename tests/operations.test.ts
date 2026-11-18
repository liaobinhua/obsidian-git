import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Operations } from '../src/operations.ts';

test('explicit actions wait for local inspection and a rejected action does not block later work',async()=>{
  const operations=new Operations();let release!:()=>void;const entered:string[]=[];
  const inspection=operations.call(async()=>{entered.push('inspect');await new Promise<void>(resolve=>{release=resolve;});});
  await Promise.resolve();const check=operations.call(async()=>{entered.push('check');});
  assert.deepEqual(entered,['inspect']);release();await Promise.all([inspection,check]);assert.deepEqual(entered,['inspect','check']);
  await assert.rejects(operations.call(async()=>{throw new Error('failed');}),/failed/);
  assert.equal(await operations.call(async()=>42),42);
});
