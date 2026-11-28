import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {failureResponse,GUEST_USER_ID,SupabaseRestStore,verifyUser} from '@/lib/boq/supabaseStore';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
const response=(status:number,error:string)=>NextResponse.json({error},{status,headers:{'Cache-Control':'no-store'}});
const max=25*1024*1024;

export async function POST(req:NextRequest,ctx:{params:Promise<{caseId:string}>}) {
  const worker=(process.env.PROCESSING_WORKER_URL??'').replace(/\/$/,'');
  const workerToken=process.env.PROCESSING_WORKER_TOKEN;
  if(!worker || !workerToken) return response(503,'The standalone schedule worker is not connected.');
  if (!req.headers.get('authorization')) return response(401,'Sign in to run the standalone engine on private project files.');
  try {
    const {caseId}=await ctx.params;
    if (!caseId || caseId.startsWith('session-')) return response(400,'A saved private PVR case is required.');
    const u=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const user=await verifyUser(req.headers.get('authorization'),u,key);
    if(user.id===GUEST_USER_ID) return response(401,'A signed-in private case is required for programme simulation.');
    if(Number(req.headers.get('content-length'))>2000)return response(413,'Schedule request is too large.');
    const raw=await req.text();
    if(raw.length>2000)return response(413,'Schedule request is too large.');
    const b=JSON.parse(raw) as {docId?:unknown;sha256?:unknown;activity?:unknown;addedHours?:unknown};
    if(!b || typeof b.docId!=='string'|| !b.docId || b.docId.length>160 || typeof b.sha256!=='string'|| !/^[a-f0-9]{64}$/.test(b.sha256)) return response(400,'Select a valid programme revision.');
    const headers:Record<string,string>={Authorization:`Bearer ${workerToken}`,'Content-Type':'application/octet-stream','X-Schedule-Sha256':b.sha256};
    if(b.activity!=null || b.addedHours!=null) {
      if(typeof b.activity!=='string'|| !b.activity.trim() || b.activity.length>100 || /[\u0000-\u001f\u007f]/.test(b.activity) ||
        typeof b.addedHours!=='number'|| !Number.isFinite(b.addedHours)|| b.addedHours<=0 || b.addedHours>8760) return response(400,'Enter a valid activity and added working hours.');
      headers['X-Schedule-Change-Code']=encodeURIComponent(b.activity);
      headers['X-Schedule-Change-Hours']=String(b.addedHours);
    }
    const store=new SupabaseRestStore(u,key,user);
    const doc=(await store.listDocuments(caseId)).find(d=>d.id===b.docId && d.role==='schedule');
    if(!doc || !doc.stored || doc.sha256!==b.sha256 || !/\.xer$/i.test(doc.name))return response(409,'The selected XER has changed or is not stored. Reopen the case.');
    const name=doc.name.replace(/_/g,' ');
    if(doc.subrole==='reference' || (!/\b(?:pre|before)[ -]?impact\b/i.test(name) && /\b(?:impacted|impact|post[- ]?impact)\b/i.test(name))) return response(400,'A processed or impacted XER is reference only.');
    if(!doc.size || doc.size>max) return response(413,'XER exceeds the supported 25 MiB size.');
    const file=await store.readDocument(caseId,doc.id);
    if(file.bytes.length>max || file.sha256!==b.sha256 || createHash('sha256').update(file.bytes).digest('hex')!==b.sha256) return response(409,'The stored XER does not match the selected revision.');
    const r=await fetch(`${worker}/schedule/cpm`,{method:'POST',headers,body:Buffer.from(file.bytes),cache:'no-store',redirect:'error',signal:AbortSignal.any([req.signal,AbortSignal.timeout(105000)])});
    const result=await r.json().catch(()=>null);
    if(r.status===404) return response(503,'The connected worker does not yet have the schedule engine. Update the processing worker.');
    if(!r.ok || !result || result.sourceSha256!==b.sha256) return response(r.ok?502:r.status,(typeof result?.error==='string'?result.error:'The standalone schedule worker did not return a verified result.').slice(0,240));
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(e) {
    if(e instanceof SyntaxError)return response(400,'Invalid schedule request.');
    if(e instanceof Error && (e.name==='TimeoutError'||e.name==='AbortError')) return response(504,'The schedule calculation did not finish in time.');
    if(e instanceof TypeError)return response(503,'The standalone schedule worker could not be reached.');
    const f=failureResponse(e);return response(f.status,f.status<500?String(f.body.error):'Could not load the selected private programme.');
  }
}
