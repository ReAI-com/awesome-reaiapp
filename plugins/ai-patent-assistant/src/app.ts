import { defineApp } from '@reai/app-sdk/v1';
import { EmployeeController } from './controller';
import { EmployeeRepository } from './repository';
import { EmployeeAgent, createDemoAgentAdapter, createHostAgentAdapter } from './agent';
import { mountEmployee } from './view';
import { createHostVoiceAdapter } from './voice';
import manifest from '../app.manifest.json';
import { CHANGELOG_TEXT } from './release-notes';
import './employee.css';

export default defineApp({
  async activate(ctx) {
    const capabilities: readonly string[]=manifest.requires.hostCapabilities;
    const realAgent=capabilities.includes('agent.session@2') && capabilities.includes('cloud.model.invoke@1');
    ctx.commands.register(`${manifest.appId}.open`,async({signal})=>{
      await ctx.surfaces.open('main',{}, {signal});return {status:'ok'};
    });
    ctx.commands.register(`${manifest.appId}.agent.voice`,async({signal})=>{
      await ctx.surfaces.open('main',{intent:{type:'agent-voice'}}, {signal});return {status:'ok'};
    });
    ctx.surfaces.register('main',async(surface)=>{
      try {
        const controller=new EmployeeController(new EmployeeRepository(ctx.storage.private('employee')));
        await controller.init();
        const agent=new EmployeeAgent(controller,realAgent?createHostAgentAdapter(ctx.agent):createDemoAgentAdapter());
        const voice=createHostVoiceAdapter(ctx.services);
        const view=mountEmployee(surface.root,{controller,agent,voice,version:manifest.version,appId:manifest.appId,changelogText:CHANGELOG_TEXT,onNavigate:nav=>surface.reportNav?.(nav)});
        const applyIntent=(intent:unknown)=>{const value=intent as {type?:string;source?:string;actionId?:string;payload?:{type?:string}}|undefined;
          if(value?.type==='open-settings'||(value?.source==='host.titlebarAction'&&value.actionId==='settings'&&value.payload?.type==='open-settings'))view.showSettings();
          if(value?.type==='agent-voice')void view.startVoice().catch(()=>undefined);
        };
        applyIntent(surface.initialIntent);const stop=surface.onIntent(applyIntent);surface.ready();
        return ()=>{stop();view.dispose();voice.dispose();agent.dispose();controller.lock();};
      } catch(error){surface.fail(error);}
    });
  },
});
