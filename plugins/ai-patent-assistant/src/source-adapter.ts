import type { EmployeeController } from './controller';
import { LIMITS } from './domain';
/** A collector returns original bytes. It does not edit records or call an Agent. */
export interface SourceAdapter {
  read(options: { signal?: AbortSignal; maxItems: number; maxBytesPerItem: number }): Promise<Array<{ name:string;mimeType?:string;bytes:Uint8Array }>>;
}
/** Each admitted original is durable. A failed later item cannot remove earlier originals. */
export async function ingestSourceBatch(controller: EmployeeController, adapter: SourceAdapter, signal?: AbortSignal): Promise<{sourceIds:string[]}> {
  const check=()=>{if(signal?.aborted)throw new Error('资料采集已取消；已入库原件继续保留');};
  check();const items=await adapter.read({signal,maxItems:20,maxBytesPerItem:LIMITS.sourceBytes});check();
  if(!Array.isArray(items)||items.length>20)throw new Error('一次采集最多接受 20 份原件');
  const sourceIds:string[]=[];
  for(const item of items){check();const source=await controller.importBytes(item);sourceIds.push(source.id);}
  return {sourceIds:[...new Set(sourceIds)]};
}
