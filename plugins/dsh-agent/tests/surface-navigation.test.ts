import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { AppError, type SurfaceHandle } from "@reai/app-sdk/v1";
import { mountNavigation } from "../src/surface-navigation";
let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
const tick = () => new Promise(resolve => setTimeout(resolve,0));
test("register and clear serialize with one high water mark; disposal is idempotent", async () => {
  const root = document.createElement("div"); const seen: number[] = []; let resolve!: () => void;
  const pending = new Promise<void>(r=>resolve=r);
  const surface = {root, navigation: { async register(input:any) { seen.push(input.revision); await pending; return {accepted:true,revision:input.revision}; }, async clear(revision:number) { seen.push(revision); } }, reportError: (error:unknown)=> {throw error;} } as unknown as SurfaceHandle;
  const view = mountNavigation(surface,{rootLabel:()=>"App",backLabel:()=>"Back",rootCommand:"app.root",menu:()=>[],onBack() {}});
  view.publish(null); await tick(); view.publish({key:"settings",label:"Settings"});
  view.dispose(); view.dispose(); resolve(); await tick(); await tick();
  expect(seen).toEqual([1,3]);
  expect(root.children).toHaveLength(0);
});
test("empty footer is zero, nonempty footer reduces body space, and stale register is handled", async () => {
  const root=document.createElement("div"); const errors:unknown[]=[];
  const surface={root,navigation:{async register() {throw new AppError({code:"SURFACE_SESSION_STALE",userMessage:"Stale"});},async clear() {}},reportError:(error:unknown)=>errors.push(error)} as unknown as SurfaceHandle;
  const view=mountNavigation(surface,{rootLabel:()=>"App",backLabel:()=>"Back",rootCommand:"app.root",menu:()=>[],onBack(){}});
  const frame=root.querySelector<HTMLElement>(".reai-surface-frame")!;
  expect(frame.style.boxSizing).toBe("border-box"); // CSS custom-property geometry is checked in real Chromium.
  expect(view.footer.style.display).toBe("none");
  view.footer.append(document.createElement("span")); await tick();
  expect(view.footer.style.display).toBe("block");
  view.footer.replaceChildren(); await tick(); expect(view.footer.style.display).toBe("none");
  view.publish(null); await tick(); expect(errors).toHaveLength(0); view.dispose();
});
