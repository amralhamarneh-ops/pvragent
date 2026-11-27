import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/boq-cases/[caseId]/evidence/route';
import type { AssessmentOutcome } from './matchEngine';
import { makeMatchSnapshot, MATCH_SNAPSHOT_KEY, readMatchSnapshot } from './matchSnapshot';

const d = { id: 'd1', name: 'A.dxf', role: 'drawings', sha256: 'a'.repeat(64), version: 1 };
const item = { ref:'GR-01',description:'Guard rail',sourceFile:'BoQ.csv' };
const a = {role:'primary',quantityOrigin:'Measured from geometry',componentName:'Guard rail',quantityText:'12 m',quantitySource:'A → B',item,status:'ready',statusNote:''};
const b = {...a,componentName:'Concrete footpath',quantityText:'24 m²',item:{...item,ref:'FP-01',description:'Concrete footpath'}};
const outcome = {lines:[a,b,{...a,role:'alternative'},{...a,quantityOrigin:'User-entered'}]} as unknown as AssessmentOutcome;
const snap = makeMatchSnapshot(outcome,'boq-hash',[d],'2026-11-27T14:30:00Z');
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});

it('saves only display rows with drawing-measured quantities, limits payload size and rejects invalid evidence metadata', () => {
  expect(snap.rows.map(x => [x.quantity,x.item])).toEqual([['12 m','GR-01'],['24 m²','FP-01']]);
  const json=JSON.stringify(snap);
  expect(readMatchSnapshot(json)).toEqual(snap);
  expect(readMatchSnapshot(json.replace(d.sha256,'broken'))).toBeNull();
  expect(readMatchSnapshot('x'.repeat(650_000))).toBeNull();
  expect(snap).not.toHaveProperty('calc');
});

it('saves through the case evidence endpoint and reopens with the same account after unrelated settings saves',async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://supabase.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','anon');
  const id='case-demo'; const context={params:Promise.resolve({caseId:id})};
  let row = {case_id:id,owner_id:'owner',narrative:'original',handoff:null,updated_at:'2026-11-27T14:20:00Z',answers:{__boqInclusion:'selection',other:'answer'}};
  let concurrentEdit = true;
  vi.stubGlobal('fetch',vi.fn(async (url: string, init?:RequestInit) => {
    const path=new URL(url).pathname; const token=new Headers(init?.headers).get('authorization');
    const uid=token==='Bearer t-owner'?'owner':token==='Bearer t-other'?'other':'guest';
    if(path==='/auth/v1/user') return new Response(JSON.stringify({id:uid,email:`${uid}@example.test`}));
    if(path==='/rest/v1/pvr_cases') return new Response(JSON.stringify(uid===row.owner_id?[{id,owner_id:row.owner_id}]:[]));
    if(path==='/rest/v1/pvr_case_evidence' && init?.method==='PATCH') {
      if (concurrentEdit) {
        row = {...row, narrative:'original plus concurrent note', updated_at:'2026-11-27T14:29:00Z'};
        concurrentEdit = false;
      }
      const version = new URL(url).searchParams.get('updated_at');
      if (version !== 'eq.' + row.updated_at) return new Response('[]');
      row = {...row, ...JSON.parse(String(init.body))};
      return new Response(JSON.stringify([row]));
    }
    if(path==='/rest/v1/pvr_case_evidence') return new Response(JSON.stringify(uid===row.owner_id?[row]:[]));
    return new Response(null,{status:404});
  }));
  const req=(token:string, body?:unknown)=>new NextRequest('https://pvr.test/api/case/evidence',{method:body?'PUT':'GET',headers:token?{authorization:`Bearer ${token}`}:{},body:body?JSON.stringify(body):undefined});
  expect((await PUT(req('t-owner',{matchSnapshot:'broken'}),context)).status).toBe(400);
  expect((await PUT(req('',{matchSnapshot:JSON.stringify(snap)}),context)).status).toBe(401);
  expect((await PUT(req('t-other',{matchSnapshot:JSON.stringify(snap)}),context)).status).toBe(404);
  expect((await PUT(req('t-owner',{matchSnapshot:JSON.stringify(snap)}),context)).status).toBe(200);
  expect(row.answers).toHaveProperty('other','answer');
  expect((await PUT(req('t-owner',{answers:{new:'other'}}),context)).status).toBe(200);
  const restored = await (await GET(req('t-owner'),context)).json();
  expect(restored.evidence.narrative).toBe('original plus concurrent note');
  expect(restored.evidence.answers).toMatchObject({new:'other',__boqInclusion:'selection'});
  expect(readMatchSnapshot(restored.evidence.answers[MATCH_SNAPSHOT_KEY])).toEqual(snap);
  expect((await GET(req('t-other'),context)).status).toBe(404);
});
