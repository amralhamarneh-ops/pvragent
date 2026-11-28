import {createHash} from 'node:crypto';
import {validateAndSimulate} from '../cpm/run.mjs';

const limit=25*1024*1024;
let busy=false;

// The parent HTTP server validates the private worker token before invoking this route.
export async function scheduleCpmRoute(req,res,json) {
  if (!process.env.PVR_MPXJ_CLASSPATH) return json(res,503,{error:'Standalone schedule engine is not configured on the processing worker.'});
  if (busy) return json(res,429,{error:'A schedule run is already in progress. Try again after it finishes.'});
  const hash=req.headers['x-schedule-sha256'];
  const codeHeader=req.headers['x-schedule-change-code'];
  const hoursHeader=req.headers['x-schedule-change-hours'];
  if (req.headers['content-type']!=='application/octet-stream' || typeof hash!=='string' || !/^[a-f0-9]{64}$/.test(hash)) return json(res,400,{error:'A verified XER is required.'});
  let changes={};
  if (codeHeader!=null || hoursHeader!=null) {
    if (typeof codeHeader!=='string' || codeHeader.length>480 || typeof hoursHeader!=='string' || !/^\d+(\.\d+)?$/.test(hoursHeader)) return json(res,400,{error:'Invalid change selection.'});
    let code;
    try { code=decodeURIComponent(codeHeader); } catch { return json(res,400,{error:'Invalid activity code.'}); }
    if (!code || /[\x00-\x1f\x7f]/.test(code) || code.length>100 || !(Number(hoursHeader)>0 && Number(hoursHeader)<=8760)) return json(res,400,{error:'Enter a valid activity code and 0–8,760 added hours.'});
    changes={[code]:Number(hoursHeader)};
  }
  if (Number(req.headers['content-length'])>limit) return json(res,413,{error:'XER exceeds 25 MiB.'});
  busy=true;
  const cancel=new AbortController();
  const stop=()=>{if (!res.writableEnded) cancel.abort();};
  res.once('close',stop);
  try {
    let n=0,overflow=false; const chunks=[];
    for await(const b of req) {
      n+=b.length;
      if(n>limit) {overflow=true;break;}
      chunks.push(b);
    }
    if(overflow)return json(res,413,{error:'XER exceeds 25 MiB.'});
    const bytes=Buffer.concat(chunks,n);
    if(createHash('sha256').update(bytes).digest('hex')!==hash) return json(res,422,{error:'The XER bytes do not match the selected schedule revision.'});
    const result=await validateAndSimulate(bytes,changes,{signal:cancel.signal});
    const sim=result.simulation;
    if(!sim) return json(res,200,result);
    // Prioritise changes to scheduled dates, while retaining milestones and the selected activities.
    const moved=sim.activityChanges.filter(a=>a.before.start!==a.after.start||a.before.finish!==a.after.finish);
    const chosen=new Map([...sim.milestones,...sim.activityChanges.filter(a=>Object.hasOwn(changes,a.code)),...moved].map(a=>[a.code,a]));
    return json(res,200,{...result,simulation:{...sim,milestones:sim.milestones.slice(0,80),activityChanges:[...chosen.values()].slice(0,150),movedActivities:moved.length}});
  } catch {
    if(!res.destroyed) return json(res,422,{error:'The standalone engine could not recalculate this XER. No impact result was produced.'});
  } finally {
    res.off('close',stop); busy=false;
  }
}
