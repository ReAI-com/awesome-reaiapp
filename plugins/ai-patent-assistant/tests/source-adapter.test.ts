import { expect, test } from 'bun:test';
import { ingestSourceBatch } from '../src/source-adapter';
import { EmployeeController } from '../src/controller';
import { EmployeeRepository } from '../src/repository';
import { MemoryStore } from './repository.test';
import { FINANCE_PROFILE } from '../src/profiles';
test('an external collector can ingest facts repeatedly without duplicate originals',async()=>{
  const c=new EmployeeController(new EmployeeRepository(new MemoryStore()),{defaultProfile:FINANCE_PROFILE});await c.init();
  const fixture={read:async()=>[{name:'collector.json',mimeType:'application/json',bytes:new TextEncoder().encode('[{"日期":"2026-10-08","收支":"收入","对方":"示例客户","金额":"10"}]')} ]};
  const first=await ingestSourceBatch(c,fixture);const repeated=await ingestSourceBatch(c,fixture);
  expect(first.sourceIds).toEqual(repeated.sourceIds);expect(c.snapshot().sources.length).toBe(1);
  expect((await c.processSource(first.sourceIds[0]!)).createdCount).toBe(1);
});
test('cancellation stops collection before new facts are admitted',async()=>{
  const c=new EmployeeController(new EmployeeRepository(new MemoryStore()));await c.init();const abort=new AbortController();abort.abort();
  await expect(ingestSourceBatch(c,{read:async()=>[]},abort.signal)).rejects.toThrow('取消');expect(c.snapshot().sources.length).toBe(0);
});
