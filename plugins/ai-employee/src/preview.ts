import { EmployeeController } from './controller';
import { EmployeeRepository } from './repository';
import { createBrowserStore } from './browser-store';
import { EmployeeAgent, createDemoAgentAdapter } from './agent';
import { mountEmployee } from './view';
import { createUnavailableVoiceAdapter } from './voice';
import manifest from '../app.manifest.json';
import { CHANGELOG_TEXT } from './release-notes';
import './preview.css';
import './employee.css';

async function start() {
  const root=document.querySelector<HTMLElement>('#app');if(!root)throw new Error('找不到预览容器');
  const controller=new EmployeeController(new EmployeeRepository(createBrowserStore(manifest.appId)));
  await controller.init();
  const agent=new EmployeeAgent(controller,createDemoAgentAdapter());
  const voice=createUnavailableVoiceAdapter();
  const view=mountEmployee(root,{controller,agent,voice,version:manifest.version,appId:manifest.appId,changelogText:CHANGELOG_TEXT});
  window.addEventListener('pagehide',()=>{view.dispose();voice.dispose();agent.dispose();controller.lock();},{once:true});
}
void start().catch(error=>{const root=document.querySelector('#app');if(root)root.textContent=`工作台无法打开：${error instanceof Error?error.message:'初始化失败'}`;});
