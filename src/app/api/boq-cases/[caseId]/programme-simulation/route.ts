import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {isReferenceProgramme} from '@/lib/mapping/scheduleProvenance';
import {PROGRAMME_SNAPSHOT_KEY,readProgrammeReview,readProgrammeSnapshot} from '@/lib/assessment/programmeSnapshot';
import {matchesCurrentDrawings,type DrawingDocument} from '@/lib/boq/drawingQuantities';
import {failureResponse,GUEST_USER_ID,SupabaseRestStore,verifyUser,type CaseDocumentRecord} from '@/lib/boq/supabaseStore';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
const response=(status:number,error:string)=>NextResponse.json({error},{status,headers:{'Cache-Control':'no-store'}});
const max=25*1024*1024;

const privateStore=async (req:NextRequest)=>{
  if(!req.headers.get('authorization'))return null;
  const u=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const user=await verifyUser(req.headers.get('authorization'),u,key);
  return user.id===GUEST_USER_ID?null:new SupabaseRestStore(u,key,user);
};
const sourceDocument=(docs:CaseDocumentRecord[],id:string,sha:string)=>
  docs.find(d=>d.id===id&&d.role==='schedule'&&d.stored&&d.sha256===sha&&/\.xer$/i.test(d.name)&&!isReferenceProgramme(d.name,d.subrole));
const drawingRevisionKey=async (store:SupabaseRestStore,caseId:string,docs:CaseDocumentRecord[])=>{
  const stored=docs.filter(d=>d.role==='drawings'&&d.stored).map(d=>({id:d.id,name:d.path,sha256:d.sha256,version:d.version,role:d.role}));
  if(stored.length!==docs.filter(d=>d.role==='drawings').length)return null;
  const evidence=await store.getEvidence(caseId);
  const handoff=evidence?.handoff as {documents?:DrawingDocument[];changes?:unknown[]} | null;
  if(!handoff||!Array.isArray(handoff.documents)||!Array.isArray(handoff.changes)||!matchesCurrentDrawings(handoff.documents,stored))return null;
  const drawings=stored.map(d=>[d.id,d.name,d.sha256,d.version]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  const canonical=(x:unknown):unknown=>Array.isArray(x)?x.map(canonical)
    :x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):x;
  return {key:createHash('sha256').update(JSON.stringify([drawings,canonical(handoff.changes)])).digest('hex'),saved:evidence?.answers?.[PROGRAMME_SNAPSHOT_KEY]};
};
const json=(body:unknown)=>NextResponse.json(body,{headers:{'Cache-Control':'no-store'}});
export async function GET(req:NextRequest,ctx:{params:Promise<{caseId:string}>}) {
  try {
    const store=await privateStore(req);
    if(!store)return response(401,'A signed-in private case is required for programme simulation.');
    const {caseId}=await ctx.params;
    const docId=req.nextUrl.searchParams.get('docId')??'',sha=req.nextUrl.searchParams.get('sha256')??'';
    if(!docId||docId.length>160||!/^[a-f0-9]{64}$/.test(sha))return response(400,'Select a valid programme revision.');
    const docs=await store.listDocuments(caseId);
    if(!sourceDocument(docs,docId,sha))return json({snapshot:null});
    const drawing=await drawingRevisionKey(store,caseId,docs);
    const snapshot=readProgrammeSnapshot(drawing?.saved);
    return json({snapshot:snapshot?.docId===docId&&snapshot.sha256===sha&&snapshot.drawingKey===drawing?.key?snapshot:null});
  } catch(e) {
    const f=failureResponse(e);return response(f.status,f.status<500?String(f.body.error):'Could not load the saved programme scenario.');
  }
}

export async function POST(req:NextRequest,ctx:{params:Promise<{caseId:string}>}) {
  const worker=(process.env.PROCESSING_WORKER_URL??'').replace(/\/$/,'');
  const workerToken=process.env.PROCESSING_WORKER_TOKEN;
  if(!worker || !workerToken) return response(503,'The standalone schedule worker is not connected.');
  if (!req.headers.get('authorization')) return response(401,'Sign in to run the standalone engine on private project files.');
  try {
    const {caseId}=await ctx.params;
    if (!caseId || caseId.startsWith('session-')) return response(400,'A saved private PVR case is required.');
    const store=await privateStore(req);
    if(!store) return response(401,'A signed-in private case is required for programme simulation.');
    if(Number(req.headers.get('content-length'))>180000)return response(413,'Schedule request is too large.');
    const raw=await req.text();
    if(raw.length>180000)return response(413,'Schedule request is too large.');
    const b=JSON.parse(raw) as {docId?:unknown;sha256?:unknown;activity?:unknown;addedHours?:unknown;changes?:unknown;fragments?:unknown;review?:unknown};
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
    const review=b.review===undefined?null:readProgrammeReview(b.review);
    if(b.review!==undefined&&(!review||!modern||!(changes.size+fragments.length)))return response(400,'Invalid reviewed programme input.');
    const docs=await store.listDocuments(caseId);
    const doc=docs.find(d=>d.id===b.docId && d.role==='schedule');
    if(!doc || !doc.stored || doc.sha256!==b.sha256 || !/\.xer$/i.test(doc.name))return response(409,'The selected XER has changed or is not stored. Reopen the case.');
    if(isReferenceProgramme(doc.name,doc.subrole)) return response(400,'A processed or impacted XER is reference only.');
    if(!doc.size || doc.size>max) return response(413,'XER exceeds the supported 25 MiB size.');
    const drawing=review?await drawingRevisionKey(store,caseId,docs):null;
    if(review&&!drawing)return response(409,'Save and verify the current drawing comparison before calculating this reviewed scenario.');
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
    if(review && drawing && result.simulation) {
      try {
        const current=await store.listDocuments(caseId);
        const latest=await drawingRevisionKey(store,caseId,current);
        if(!sourceDocument(current,doc.id,doc.sha256)||latest?.key!==drawing.key)
          return response(409,'The source programme or drawings changed during the run. Reopen the case and recalculate.');
        const runAt=new Date().toISOString();
        const encoded=JSON.stringify({version:1,docId:doc.id,sha256:doc.sha256,drawingKey:drawing.key,runAt,review,result});
        if(!readProgrammeSnapshot(encoded))throw new Error('Snapshot validation failed');
        await store.saveEvidence(caseId,{programmeSnapshot:encoded});
        return json({...result,savedAt:runAt});
      } catch {
        return json({...result,saveWarning:'The scenario was calculated but could not be saved. Recalculate before leaving this case if you want to keep it.'});
      }
    }
    return json(result);
  } catch(e) {
    if(e instanceof SyntaxError)return response(400,'Invalid schedule request.');
    if(e instanceof Error && (e.name==='TimeoutError'||e.name==='AbortError')) return response(504,'The schedule calculation did not finish in time.');
    if(e instanceof TypeError)return response(503,'The standalone schedule worker could not be reached.');
    const f=failureResponse(e);return response(f.status,f.status<500?String(f.body.error):'Could not load the selected private programme.');
  }
}
