import { defineContractSuite } from '@reai/app-test/v1';
import manifest from '../app.manifest.json';
export default defineContractSuite({
  appDirectory:'..',hostApi:'1.24.0',
  expect:{surfaces:['main'],commands:[`${manifest.appId}.open`,`${manifest.appId}.agent.voice`],intents:['open-settings','agent-voice'],readySurfaces:['main'],forbiddenNetworkRequests:'all',storageNamespace:manifest.appId,noResourcesAfterUnmount:true},
  scenarios:[{
    name:'Command opens the workbench and settings stay reachable',
    async run({host,expect}){
      await host.invokeCommand(`${manifest.appId}.open`);
      const main=await host.openSurface('main');expect(main).toBeOpen();
      if(!main.root)throw new Error('测试环境缺少 DOM');
      await host.sendIntent(main.surfaceMountId,{source:'host.titlebarAction',actionId:'settings',deliveryId:'employee-settings-test',payload:{type:'open-settings'}});
      if(!main.root.textContent?.includes('关于插件'))throw new Error('设置缺少关于入口');
      if(!main.root.textContent?.includes(manifest.version))throw new Error('设置版本与安装包不同');
    },
  },{
    name:'Voice command uses the mounted Agent and leaves recognized text unsent',
    async run({host,expect}){
      const main=await host.openSurface('main');expect(main).toBeOpen();
      const root=main.root;if(!root)throw new Error('测试环境缺少 DOM');
      let resolveText: ((value:unknown)=>void)|undefined;let requestId='';let requests=0;
      host.serviceHandler=async({serviceId,method,input})=>{
        if(serviceId!=='com.reai.voice/request-text@1')throw new Error('Voice 服务标识错误');
        const request=input as {requestId:string};
        if(method==='request-text'){
          requests++;requestId=request.requestId;
          return new Promise(resolve=>{resolveText=resolve;});
        }
        if(method==='status')return {requestId:request.requestId,phase:'listening',revision:1,captureStarted:true,pcmReceived:false};
        return {accepted:true};
      };
      await host.invokeCommand(`${manifest.appId}.agent.voice`);
      const open=host.surfaceOpenRequests.at(-1);
      if(open?.surfaceId!=='main'||(open.intent as {type?:string})?.type!=='agent-voice')throw new Error('语音命令没有打开已有主界面并投递语音意图');
      // Mock Host observes SurfaceOpen; explicitly deliver its intent to this same mount.
      await host.sendIntent(main.surfaceMountId,open.intent);
      const wait=async(check:()=>boolean)=>{const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)throw new Error('语音合同状态未更新');await new Promise(resolve=>setTimeout(resolve,5));}};
      await wait(()=>!!resolveText);
      const draft='语音合同草稿，等待用户确认发送';
      resolveText!({requestId,text:draft,kind:'raw'});
      await wait(()=>root.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.value===draft);
      if(requests!==1)throw new Error('一次语音意图发起了多次识别');
      if(main.root!==root)throw new Error('语音意图替换了现有界面实例');
      if(root.querySelector('[data-messages]')?.textContent?.includes(draft))throw new Error('语音结果未经确认就提交了聊天');
    },
  }],
});
