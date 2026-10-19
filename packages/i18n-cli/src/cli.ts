#!/usr/bin/env bun
import { buildApp, packApp, parseCompression, validateManifestFile, readSourceReviewEvidence } from "./index";
import { join, resolve } from "node:path";
import { BuildError } from "@reai/app-cli";
import { readFileSync } from "node:fs";
const usage="reai-app-i18n validate <appDir> | build <appDir> | pack <appDir> --out <package.reaiapp> [--source-review <evidence.json>] [--compression store|deflate]";
async function main(){
  const [command,directory,...args]=process.argv.slice(2);
  if(command==="--help"||command==="-h"){console.log(usage);return;}
  if(command==="--version"){console.log(JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version);return;}
  if(!directory)throw new Error(usage);
  const options=new Map<string,string>();
  if(args.length%2)throw new Error(usage);
  for(let at=0;at<args.length;at+=2){
    const key=args[at]!,value=args[at+1]!;
    if(!["--source-review",...(command==="pack"?["--out","--compression"]:[])].includes(key)||!value||value.startsWith("--")||options.has(key))throw new Error(usage);
    options.set(key,value);
  }
  const compression=parseCompression(options.get("--compression")),reviewPath=options.get("--source-review");
  const sourceReview=reviewPath?readSourceReviewEvidence(reviewPath):undefined;
  if(sourceReview)console.log("Source review evidence: local submission preflight only; no Host runtime authorization");
  if(command==="validate"){
    const findings=validateManifestFile(join(resolve(directory),"app.manifest.json"),true,sourceReview);
    if(findings.length)throw new BuildError("Plugin language validation failed",findings);
    console.log("✓ Manifest, language resources and metadata references validated");
  }else if(command==="build"){
    await buildApp(directory,true,sourceReview);console.log("✓ Built with language validation");
  }else if(command==="pack"){
    const output=options.get("--out");
    if(!output)throw new Error(usage);
    const result=await packApp(directory,output,true,sourceReview,{compression});console.log(`✓ ${result.outputPath}\nSHA-256 ${result.archiveDigest}`);
  }else throw new Error(usage);
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));if(error instanceof BuildError)for(const f of error.findings)console.error(`[${f.code}] ${f.pointer}: ${f.detail}`);process.exitCode=1;});
