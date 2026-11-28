import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {isReferenceProgramme} from '@/lib/mapping/scheduleProvenance';
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
    if(Number(req.headers.get('content-length'))>12000)return response(413,'Schedule request is too large.');
    const raw=await req.text();
    if(raw.length>12000)return response(413,'Schedule request is too large.');
    const b=JSON.parse(raw) as {docId?:unknown;sha256?:unknown;activity?:unknown;addedHours?:unknown;changes?:unknown;fragments?:unknown};
    if(!b || typeof b.docId!=='string'|| !b.docId || b.docId.length>160 || typeof b.sha256!=='string'|| !/^[a-f0-9]{64}$/.test(b.sha256)) return response(400,'Select a valid programme revision.');
    const headers:Record<string,string>={Authorization:`Bearer ${workerToken}`,'Content-Type':'application/octet-stream','X-Schedule-Sha256':b.sha256};
    const modern=Object.hasOwn(b,'changes') || Object.hasOwn(b,'fragments');
    const changes=new Map<string,number>(), fragments:{code:string;from:string;to:string;hours:number}[]=[];
    if(modern) {
      if(b.activity!=null||b.addedHours!=null||!Array.isArray(b.changes)||!Array.isArray(b.fragments)||b.changes.length+b.fragments.length>30)return response(400,'Invalid scenario scope.');
      const validCode=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=100&&!/[\u0000-\u001f\u007f]/.test(v);
      const validHours=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=1/60&&v<=8760&&Math.abs(v*60-Math.round(v*60))<=1e-7;
      for(const item of b.changes) {
        const {code,hours}=item??{};
        if(!validCode(code)||!validHours(hours)||changes.has(code))return response(400,'Enter unique activities and positive working durations in whole minutes.');
        changes.set(code,hours);
      }
      const codes=new Set(changes.keys());
      for(const item of b.fragments) {
        const {code,from,to,hours}=item??{};
        if(typeof code!=='string'||!/^PVR-NEW-[1-9][0-9]{0,5}$/.test(code)||codes.has(code)||!validCode(from)||!validCode(to)||from===to||!validHours(hours))
          return response(400,'Enter a valid new activity with two different source anchors and a positive duration.');
        codes.add(code);fragments.push({code,from,to,hours});
      }
      const encoded=Buffer.from(JSON.stringify([[...changes],fragments.map(f=>[f.code,f.from,f.to,f.hours])])).toString('base64url');
      if(encoded.length>5200)return response(413,'Activity change list is too large.');
      headers['X-Schedule-Changes']=encoded;
    } else if(b.activity!=null || b.addedHours!=null) {
      if(typeof b.activity!=='string'|| !b.activity.trim() || b.activity.length>100 || /[\u0000-\u001f\u007f]/.test(b.activity) ||
        typeof b.addedHours!=='number'|| !Number.isFinite(b.addedHours)|| b.addedHours<=0 || b.addedHours>8760) return response(400,'Enter a valid activity and added working hours.');
      headers['X-Schedule-Change-Code']=encodeURIComponent(b.activity);
      headers['X-Schedule-Change-Hours']=String(b.addedHours);
    }
    const store=new SupabaseRestStore(u,key,user);
    const doc=(await store.listDocuments(caseId)).find(d=>d.id===b.docId && d.role==='schedule');
    if(!doc || !doc.stored || doc.sha256!==b.sha256 || !/\.xer$/i.test(doc.name))return response(409,'The selected XER has changed or is not stored. Reopen the case.');
    if(isReferenceProgramme(doc.name,doc.subrole)) return response(400,'A processed or impacted XER is reference only.');
    if(!doc.size || doc.size>max) return response(413,'XER exceeds the supported 25 MiB size.');
    const file=await store.readDocument(caseId,doc.id);
    if(file.bytes.length>max || file.sha256!==b.sha256 || createHash('sha256').update(file.bytes).digest('hex')!==b.sha256) return response(409,'The stored XER does not match the selected revision.');
    const r=await fetch(`${worker}/schedule/cpm${modern?'/v2':''}`,{method:'POST',headers,body:Buffer.from(file.bytes),cache:'no-store',redirect:'error',signal:AbortSignal.any([req.signal,AbortSignal.timeout(105000)])});
    const result=await r.json().catch(()=>null);
    if(r.status===404) return response(503,'The connected worker does not yet have the schedule engine. Update the processing worker.');
    if(!r.ok || !result || result.sourceSha256!==b.sha256) return response(r.ok?502:r.status,(typeof result?.error==='string'?result.error:'The standalone schedule worker did not return a verified result.').slice(0,240));
    if(modern && (result.revision!==2 || typeof result.control?.ok!=='boolean' || (result.simulation===null
      ? result.control.ok && changes.size+fragments.length>0 && typeof result.scenarioBlocker!=='string'
      : !result.control.ok || !(changes.size+fragments.length) || !result.simulation?.changes || Object.keys(result.simulation.changes).length!==changes.size ||
      [...changes].some(([code,hours])=>!Object.hasOwn(result.simulation.changes,code)||result.simulation.changes[code]!==hours) || JSON.stringify(result.simulation.fragments)!==JSON.stringify(fragments))))
      return response(502,'The worker did not verify this exact scenario. No result was accepted.');
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(e) {
    if(e instanceof SyntaxError)return response(400,'Invalid schedule request.');
    if(e instanceof Error && (e.name==='TimeoutError'||e.name==='AbortError')) return response(504,'The schedule calculation did not finish in time.');
    if(e instanceof TypeError)return response(503,'The standalone schedule worker could not be reached.');
    const f=failureResponse(e);return response(f.status,f.status<500?String(f.body.error):'Could not load the selected private programme.');
  }
}
