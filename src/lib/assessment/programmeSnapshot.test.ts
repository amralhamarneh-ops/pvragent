import {expect,it} from 'vitest';
import {mergeMatchSnapshotAnswers,MATCH_SNAPSHOT_KEY} from '../boq/matchSnapshot';
import {PROGRAMME_SNAPSHOT_KEY,programmeScopeKey,readProgrammeReview,readProgrammeSnapshot} from './programmeSnapshot';
const line={id:'drawing:1',name:'Drainage works',quantity:'12',unit:'m',drawingSource:'Drawing A → B',boqSource:'',activityCodes:['D01'],split:{D01:'100'}};
const date='2027-02-02T17:00:00';
const sha='a'.repeat(64);
const review={scopeKey:programmeScopeKey([line]),decisions:{'drawing:1':{treatment:'include',rate:'1.5',basis:'Crew record'}}};
const result={revision:2,sourceSha256:sha,control:{ok:true,activities:2,dateMismatches:0,floatMismatches:0,milestones:1,milestoneDateMismatches:0,calculatedFinish:date,reasons:[]},simulation:{before:date,after:'2027-02-03T17:00:00',calendarDays:1,elapsedHours:24,activityChanges:[],milestones:[],movedActivities:0,changedMilestones:0,affectedActivities:0,drivingTieCount:0,drivingTies:[]}};
const snapshot={version:1,docId:'source-xer',sha256:sha,drawingKey:'b'.repeat(64),runAt:'2026-11-28T08:00:00.000Z',review,result};
it('restores only an intact reviewed and calculated snapshot',()=>{
 expect(readProgrammeSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
 expect(readProgrammeSnapshot(JSON.stringify({...snapshot,sha256:'c'.repeat(64)}))).toBeNull();
 expect(readProgrammeSnapshot(JSON.stringify({...snapshot,result:{...result,simulation:null}}))).toBeNull();
 expect(readProgrammeReview({...review,decisions:{'drawing:1':{...review.decisions['drawing:1'],rate:123}}})).toBeNull();
});
it('ignores a pure BOQ citation change, but not changed allocation or drawing quantities',()=>{
 expect(programmeScopeKey([{...line,boqSource:'Bill 4 · rate confirmation'}])).toBe(review.scopeKey);
 expect(programmeScopeKey([{...line,quantity:'14'}])).not.toBe(review.scopeKey);
 expect(programmeScopeKey([{...line,activityCodes:['D02']}])).not.toBe(review.scopeKey);
});
it('ordinary evidence cannot inject or clear the reserved calculated scenario',()=>{
 const fake={[PROGRAMME_SNAPSHOT_KEY]:'not computed',answer:'changed'};
 expect(mergeMatchSnapshotAnswers({},fake)).toEqual({answer:'changed'});
 expect(mergeMatchSnapshotAnswers({[PROGRAMME_SNAPSHOT_KEY]:'computed',[MATCH_SNAPSHOT_KEY]:'match'},fake)).toEqual({answer:'changed',[PROGRAMME_SNAPSHOT_KEY]:'computed',[MATCH_SNAPSHOT_KEY]:'match'});
 expect(mergeMatchSnapshotAnswers({answer:'old'},undefined,undefined,'new result')).toEqual({answer:'old',[PROGRAMME_SNAPSHOT_KEY]:'new result'});
});
