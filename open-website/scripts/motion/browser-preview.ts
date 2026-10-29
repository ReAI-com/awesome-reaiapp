// Offline capture adapter: the UI is the plugin's own view, with public sample data.
import {mountBrowserHome, refreshBrowserHome, setBrowserHomeActivity} from '../../../plugins/browser/src/browser-view';
const initial = {tabs:[{tabId:1,title:'ReAI · 开放平台',url:'https://open.reai.com/',loading:false,openedByAgent:false}],activeTabId:1,agentTabId:null};
const added = {tabId:2,title:'插件开发指南 · ReAI',url:'https://open.reai.com/docs/plugin-development-v1',loading:false,openedByAgent:true};
let state:any = structuredClone(initial);
const root = document.querySelector<HTMLElement>('#app')!;
const home = mountBrowserHome(root, {
  onOpenDrawer() {},
  onNewTab() {},
  onRefresh() {},
  onSelectTab(tabId) {state.activeTabId=tabId;refreshBrowserHome(home,state);},
  onCloseTab(tabId) {state.tabs=state.tabs.filter((tab:any)=>tab.tabId!==tabId);state.activeTabId=1;state.agentTabId=null;refreshBrowserHome(home,state);},
});
refreshBrowserHome(home,state);
Object.assign(window, {previewBrowser: {
  reset() {state=structuredClone(initial);setBrowserHomeActivity(home,undefined,0);refreshBrowserHome(home,state);},
  opening(ms:number) {setBrowserHomeActivity(home,{phase:'new',url:added.url},ms);},
  opened() {state={tabs:[...initial.tabs,added],activeTabId:2,agentTabId:2};setBrowserHomeActivity(home,undefined,0);refreshBrowserHome(home,state);},
  reading(ms:number) {setBrowserHomeActivity(home,{phase:'select',tabId:1},ms);},
  selected() {state.activeTabId=1;setBrowserHomeActivity(home,undefined,0);refreshBrowserHome(home,state);},
}});
