import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const enc=new TextEncoder();
const hex=(b:ArrayBuffer)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function valid(body:string,sig:string,secret:string){
 if(!sig.startsWith("sha256="))return false;
 const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const expected="sha256="+hex(await crypto.subtle.sign("HMAC",key,enc.encode(body)));
 if(expected.length!==sig.length)return false;let d=0;for(let i=0;i<expected.length;i++)d|=expected.charCodeAt(i)^sig.charCodeAt(i);return d===0;
}
function mapped(event:string,p:any){
 const action=String(p.action||"");let stage="github",status:string|null=null,percent:number|null=null,title=event;
 if(event==="workflow_run"){stage="ci";status=p.workflow_run?.status||null;percent=status==="completed"?100:null;title=p.workflow_run?.name||"GitHub Actions";}
 else if(event==="workflow_job"){stage="ci";status=p.workflow_job?.status||null;percent=status==="completed"?100:null;title=p.workflow_job?.name||"Job";}
 else if(event==="pull_request"){stage="pull_request";status=p.pull_request?.merged?"merged":action;title=p.pull_request?.title||"Pull request";}
 else if(event==="push"){stage="commit";status="pushed";title=p.head_commit?.message||"Push";}
 else if(event==="create"){stage=p.ref_type==="branch"?"branch":"github";status="created";title=p.ref_type==="branch"?"Branch criada":"Referência criada";}
 return {action,stage,status,percent,title};
}
Deno.serve(async(req)=>{
 if(req.method!=="POST")return new Response("method",{status:405});
 const secret=Deno.env.get("GITHUB_WEBHOOK_SECRET")||"";if(!secret)return new Response("secret unavailable",{status:503});
 const body=await req.text();if(!(await valid(body,req.headers.get("x-hub-signature-256")||"",secret)))return new Response("invalid signature",{status:401});
 const delivery=req.headers.get("x-github-delivery")||"";const event=req.headers.get("x-github-event")||"";if(!delivery||!event)return new Response("missing headers",{status:400});
 if(event==="ping")return new Response("ok");
 let p:any;try{p=JSON.parse(body)}catch{return new Response("invalid json",{status:400})}
 const repo=String(p.repository?.full_name||"");if(!repo)return new Response("repository required",{status:400});
 const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
 const {data:project,error:pe}=await admin.from("bridge_projects").select("id").eq("github_repo_full_name",repo).maybeSingle();
 if(pe)return new Response("project lookup failed",{status:500});if(!project)return new Response("project not registered",{status:202});
 const m=mapped(event,p),run=p.workflow_run||p.workflow_job||{};
 const row={project_id:project.id,source:"github",delivery_id:delivery,event_type:event,action:m.action,stage:m.stage,status:m.status,percent:m.percent,title:String(m.title).slice(0,240),message:String(p.head_commit?.message||p.pull_request?.title||"").slice(0,1000)||null,repo_full_name:repo,ref:p.ref||p.pull_request?.head?.ref||null,sha:p.after||p.pull_request?.head?.sha||run.head_sha||null,run_id:run.id||null,run_url:run.html_url||p.pull_request?.html_url||null,payload:{sender:p.sender?.login||null,number:p.number||null}};
 const {error}=await admin.from("bridge_live_events").upsert(row,{onConflict:"source,delivery_id",ignoreDuplicates:true});if(error)return new Response("persist failed",{status:500});
 return Response.json({ok:true});
});