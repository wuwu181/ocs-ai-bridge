import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { WorkspaceDB, ipAllowed, questionKey } from '../lib/database.mjs';
import { chinaClock, estimateCost, defaultBilling } from '../lib/pricing.mjs';
import { createRuntime } from '../lib/portable.mjs';
import { initializeFiles } from '../lib/store.mjs';
import { projectRoot, validateConfig } from '../lib/config.mjs';
import { createBridgeServer } from '../server.mjs';
import { Solver } from '../lib/solver.mjs';
const r=createRuntime();
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'ocs-v3-'));
  copyFileSync(resolve(projectRoot,'config.example.json'),resolve(root,'config.example.json'));
  const store=initializeFiles(root,{}),p=store.publicConfig();
  p.config.profiles.deepseek.authStyle='none'; p.config.profiles.deepseek.pricing={input:1,cached:0,output:2,peakMultiplier:1};
  store.save({...p});return store;
}
const response=(content,usage={prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:60})=>new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage}));
async function withServer(fn) {
  const store=fixture();let calls=0;
  const b=createBridgeServer(store.config,{store,fetchImpl:async()=>{calls++;return response('B');}});
  b.server.listen(0,'127.0.0.1');await once(b.server,'listening');const base=`http://127.0.0.1:${b.server.address().port}`;
  async function req(url,method='GET',value,token=store.config.token,headers={}){const res=await fetch(base+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(value?{body:JSON.stringify(value)}:{})});return {status:res.status,data:await res.json()};}
  try{await fn({store,b,req,calls:()=>calls});}finally{b.server.closeAllConnections();await new Promise(resolve=>b.server.close(resolve));}
}
test('judgement maps explicit source labels, supports reversed order, and never assumes A=true',()=>{
  const q=options=>r.normalize({title:'创新是经济学概念。',type:'judgement',options});
  assert.equal(r.answer('A',q(['正确','错误'])).answer,'对');
  assert.equal(r.answer('A',q(['错误','正确'])).answer,'错');
  assert.equal(r.answer('B',q(['错误','正确'])).answer,'对');
  assert.throws(()=>r.answer('A',q([])),{code:'invalid_answer'});
  assert.throws(()=>r.answer('B',q(['选项一','选项二'])),{code:'invalid_answer'});
});
test('one-attempt lite judgement makes one bounded full-format repair when mapping is impossible',async()=>{
  const store=fixture();let calls=0;const sent=[];
  const solver=new Solver(store.config,{fetchImpl:async(url,o)=>{sent.push(JSON.parse(o.body));return response(++calls===1?'A':'{"kind":"judgement","answer":"对"}');}});
  const value=await solver.solve({title:'1+1=2',type:'judgement',mode:'lite'});
  assert.equal(value.answer,'对');assert.equal(calls,2);assert.ok(sent[1].max_tokens>32);assert.equal(value.model_calls,2);assert.equal(value.usage.total_tokens,220);assert.equal(value.cost.calls.length,2);
});
test('SQLite persists exact bank answers, Chinese search, edited answers and disabled records',()=>{
  const root=mkdtempSync(join(tmpdir(),'ocs-bank-')),q=r.normalize({title:'创新是经济学概念。',type:'judgement',options:['错误','正确']});
  let db=new WorkspaceDB(root,'test-admin');db.remember(q,{kind:'judgement',answer:'对',display_answer:'对',choices:[],profile:'deepseek',model:'test'});
  assert.equal(db.listQuestions('经济学').total,1);assert.equal(db.listQuestions('创新').total,1);
  assert.equal(db.listQuestions('" OR 1=1 --').total,0);
  const id=db.listQuestions().items[0].id;
  db.close();db=new WorkspaceDB(root,'test-admin');assert.equal(db.lookup(q).source,'database');assert.equal(db.lookup(q).usage.total_tokens,0);
  const item=db.question(id);db.saveQuestion({input:item.input,answer:'错',enabled:false},id);assert.equal(db.lookup(q),null);
  db.saveQuestion({input:item.input,answer:'错',enabled:true},id);assert.equal(db.lookup(q).answer,'错');assert.equal(db.lookup(q).reviewed,true);
  assert.notEqual(questionKey(q),questionKey(r.normalize({title:q.title,type:'judgement',options:['正确','错误']})));
  db.close();
});
test('bank supports all five types and preserves code, fill arrays, images and option order',()=>{
  const db=new WorkspaceDB();
  for(const [type,answer] of [['single','B'],['multiple','AC'],['judgement','对'],['completion',['C#','#include <x>']],['subjective','if (a | b) {\n  return 1;\n}']]){
    const input={title:type+'题',type,options:['a','b','c']};db.saveQuestion({input,answer});
    assert.equal(db.lookup(r.normalize(input)).kind,type);
  }
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const imageInput={title:'看图题[图片1]',type:'single',options:['甲','乙'],images:[png]};
  db.saveQuestion({input:imageInput,answer:'B'});assert.equal(db.lookup(r.normalize(imageInput)).answer,'B');
  assert.equal(db.listQuestions().total,6);db.close();
});
test('Beijing tariff boundaries, weekends, national holidays and cache input split',()=>{
  for(const [time,peak] of [['2026-11-05T00:59:59Z',false],['2026-11-05T01:00:00Z',true],['2026-11-05T04:00:00Z',false],['2026-11-05T06:00:00Z',true],['2026-11-05T10:00:00Z',false],['2026-11-07T02:00:00Z',false],['2026-10-01T02:00:00Z',false]])assert.equal(chinaClock(time).peak,peak,time);
  assert.equal(chinaClock('2026-11-05T16:00:00Z').day,'2026-11-06');
  const profile={endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash'};
  const usage={reported:true,input_tokens:1e6,output_tokens:1e6,cache_hit_tokens:5e5};
  assert.equal(estimateCost(profile,usage,'2026-11-05T01:00:00Z').amount,9.02);
  assert.equal(estimateCost({...profile,endpoint:'https://third-party.example/v1/chat/completions'},usage).known,false);
  assert.equal(estimateCost(profile,{reported:false}).known,false);
  assert.equal(defaultBilling.checkedAt,'2026-11-05');
});
test('device secrets stay encrypted; daily requests and concurrency are enforced across restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'ocs-device-'));let db=new WorkspaceDB(root,'admin-token');
  const {id}=db.saveDevice({name:'手机',settings:{dailyRequests:1}}),token=db.deviceToken(id),device=db.identify(token);
  assert.equal(JSON.stringify(db.devices()).includes(token),false);assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM devices').get()).includes(token),false);
  const identity=db.admit(device,'127.0.0.1','req1');assert.throws(()=>db.admit(device,'127.0.0.1','req2'),{code:'device_quota'});
  db.finish('req1',identity,{code:1,usage:{total_tokens:15},cost:{known:true,amount:0.0001}});db.close();
  db=new WorkspaceDB(root,'admin-token');assert.equal(db.identify(token).id,id);assert.throws(()=>db.admit(db.identify(token),'127.0.0.1','req3'),{code:'device_quota'});db.close();
  assert.ok(ipAllowed('::ffff:192.168.1.22',['192.168.1.0/24']));assert.equal(ipAllowed('192.168.2.1',['192.168.1.0/24']),false);
});
test('device export cannot administer, spoof IP, select forbidden models or exceed its daily count',async()=>{
  await withServer(async({req,calls})=>{
    const created=await req('/admin/devices','POST',{name:'平板',settings:{dailyRequests:1,profiles:['deepseek'],ips:['127.0.0.1']}});assert.equal(created.status,200);
    const exported=await req('/admin/ocs-config?device='+created.data.id+'&base=http://192.168.1.20:8765');assert.equal(exported.status,200);
    const token=exported.data[0].headers.Authorization.slice(7);
    assert.equal((await req('/admin/config','GET',null,token)).status,401);
    assert.equal((await req('/api/answer','POST',{title:'1+1',type:'single',profile:'openai'},token)).status,403);
    const answered=await req('/api/answer/lite','POST',{title:'1+1',type:'single',options:['1','2']},token,{'X-Forwarded-For':'8.8.8.8'});assert.equal(answered.data.answer,'B');assert.equal(calls(),1);
    assert.equal((await req('/api/answer','POST',{title:'再次请求',type:'single'},token)).status,429);
    const stats=(await req('/admin/analytics')).data;assert.equal(stats.totals.requests,1);assert.equal(stats.ips[0].ip,'127.0.0.1');assert.equal(stats.totals.tokens,110);
    assert.equal((await req('/admin/ocs-config?base=https://ai.example.com')).status,400);
  });
});
test('AI saves once, bank bypasses model, editing invalidates old memory cache, and user can force AI',async()=>{
  await withServer(async({req,calls})=>{
    const q={title:'1+1',type:'single',options:['1','2']};
    assert.equal((await req('/api/answer/lite','POST',q)).data.source,'ai');
    assert.equal((await req('/api/answer/lite','POST',q)).data.source,'database');assert.equal(calls(),1);
    const row=(await req('/admin/questions?q=1%2B1')).data.items[0];
    assert.equal((await req('/admin/questions/'+row.id,'PUT',{input:q,answer:'A',reviewed:true})).status,200);
    assert.equal((await req('/api/answer/lite','POST',q)).data.answer,'A');
    assert.equal((await req('/admin/test','POST',q)).data.answer,'B');assert.equal(calls(),2);
    assert.equal((await req('/admin/analytics')).data.totals.bank_hits,2);
  });
});
test('configuration rejects invalid prices, proxy lists and network addresses',()=>{
  const store=fixture(),{config}=store.publicConfig(),env={OCS_BRIDGE_TOKEN:store.config.token};
  for(const change of [c=>c.billing.prices={'bad':{input:-1,output:1}},c=>c.network.trustedProxies=['0.0.0.0/0'],c=>c.server.host='arbitrary-host']){const c=structuredClone(config);change(c);assert.throws(()=>validateConfig(c,env));}
});

test('review-only reuse skips unreviewed memory answers; request quota counts but free pre-call failures do not create unknown charges',async()=>{
  const store=fixture();store.config.bank.reviewedOnly=true;const db=new WorkspaceDB();let calls=0;
  const solver=new Solver(store.config,{database:db,fetchImpl:async()=>{calls++;return response('B');}}),q={title:'review-only',type:'single',options:['a','b'],mode:'lite'};
  await solver.solve(q);await solver.solve(q);assert.equal(calls,2);
  const {id}=db.saveDevice({name:'限额设备',settings:{dailyCost:1,dailyRequests:0,maxConcurrent:1}}),device=db.identify(db.deviceToken(id));
  const identity=db.admit(device,'127.0.0.1','free-failure');db.finish('free-failure',identity,{code:0});
  assert.equal(db.totals(undefined,id).unknown_cost,0);
  db.admit(device,'127.0.0.1','pending');assert.throws(()=>db.admit(device,'127.0.0.1','concurrent'),{code:'device_quota'});
  db.close();
});
