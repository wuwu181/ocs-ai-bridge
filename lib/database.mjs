import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { createRuntime } from './portable.mjs';
import { BridgeError } from './providers.mjs';
import { chinaClock } from './pricing.mjs';
const runtime = createRuntime();
const digest = x => createHash('sha256').update(x).digest('hex');
const zero = () => ({ reported: true, input_tokens: 0, output_tokens: 0, total_tokens: 0 });
export function questionKey(q) {
  // Keep punctuation, case, option order and image content. No fuzzy auto-answering.
  const clean = x => x.normalize('NFC').replace(/\r\n/g, '\n').trim();
  return digest(JSON.stringify([q.kind, clean(q.title), q.promptOptions.map(clean), q.blankCount, q.images.map(i => digest(i.url))]));
}
export function ipAllowed(ip, rules) {
  ip = ip.replace(/^::ffff:/, '');
  return !rules.length || rules.some(rule => {
    if (!rule.includes('/')) return ip === rule.replace(/^::ffff:/, '');
    const [net, bits] = rule.split('/');
    if (isIP(ip) !== 4 || isIP(net) !== 4 || !/^\d+$/.test(bits) || +bits > 32) return false;
    const number = value => value.split('.').reduce((n, v) => (n * 256 + +v) >>> 0, 0);
    const mask = +bits === 0 ? 0 : (0xffffffff << (32 - +bits)) >>> 0;
    return (number(ip) & mask) === (number(net) & mask);
  });
}
export class WorkspaceDB {
  constructor(root = null, token = '') {
    if (root) mkdirSync(join(root, 'data'), { recursive: true });
    this.db = new DatabaseSync(root ? join(root, 'data', 'workspace.sqlite') : ':memory:');
    this.key = createHash('sha256').update(token).digest();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, reviewed INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(title, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS questions_ai AFTER INSERT ON questions BEGIN INSERT INTO questions_fts(rowid,title) VALUES(new.id,new.title); END;
      CREATE TRIGGER IF NOT EXISTS questions_ad AFTER DELETE ON questions BEGIN DELETE FROM questions_fts WHERE rowid=old.id; END;
      CREATE TRIGGER IF NOT EXISTS questions_au AFTER UPDATE OF title ON questions BEGIN DELETE FROM questions_fts WHERE rowid=old.id; INSERT INTO questions_fts(rowid,title) VALUES(new.id,new.title); END;
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, token_cipher TEXT NOT NULL, settings TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, device TEXT NOT NULL, ip TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, cost_known INTEGER NOT NULL DEFAULT 0, bank_hit INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS requests_device_day ON requests(device,day);
      CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
      PRAGMA user_version=1;`);
    // Keep the count and mark the charge unknown if the previous process died before settlement.
    this.db.exec('UPDATE requests SET finished=1,cost_known=0 WHERE finished=0');
    this.active = new Map(); this.closed = false;
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  seal(token) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
  }
  deviceToken(id) {
    const row = this.db.prepare('SELECT token_cipher FROM devices WHERE id=?').get(id);
    if (!row) throw new BridgeError('device_missing', '设备不存在。', 404);
    try {
      const b = Buffer.from(row.token_cipher, 'base64'), d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0,12)); d.setAuthTag(b.subarray(12,28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch { throw new BridgeError('device_token', '本机管理令牌已变化，请重新创建设备。', 409); }
  }
  saveDevice(value, id = null) {
    const settings = { enabled: true, dailyRequests: 1000, dailyTokens: 0, dailyCost: 0, rpm: 30, maxConcurrent: 1, ips: [], profiles: [], ...value.settings };
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new BridgeError('device_name', '设备名称需要 1 至 80 字符。', 400);
    for (const key of ['dailyRequests','dailyTokens','rpm','maxConcurrent']) if (!Number.isSafeInteger(settings[key]) || settings[key] < 0 || key === 'maxConcurrent' && settings[key] < 1) throw new BridgeError('device_limit', '设备次数/Token/并发限制必须为非负整数，并发至少为1。', 400);
    if (typeof settings.enabled !== 'boolean' || !Number.isFinite(settings.dailyCost) || settings.dailyCost < 0 || !Array.isArray(settings.ips) || settings.ips.some(x => typeof x !== 'string' || !(isIP(x) || /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(x) && isIP(x.split('/')[0]) === 4)) || !Array.isArray(settings.profiles) || settings.profiles.some(x => typeof x !== 'string')) throw new BridgeError('device_limit', '设备金额/IP/模型设置无效。', 400);
    if (id) {
      if (!this.db.prepare('SELECT id FROM devices WHERE id=?').get(id)) throw new BridgeError('device_missing', '设备不存在。', 404);
      this.db.prepare('UPDATE devices SET name=?,settings=? WHERE id=?').run(value.name.trim(), JSON.stringify(settings), id);
    } else {
      id = randomUUID(); const token = randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?)').run(id,value.name.trim(),digest(token),this.seal(token),JSON.stringify(settings),new Date().toISOString());
    }
    return { id };
  }
  devices(day = chinaClock().day) {
    return this.db.prepare('SELECT id,name,settings,created FROM devices ORDER BY created DESC').all().map(row => ({ ...row, settings: JSON.parse(row.settings), usage: this.totals(day,row.id), active: this.active.get(row.id) || 0 }));
  }
  identify(token) {
    const row = this.db.prepare('SELECT id,name,settings FROM devices WHERE token_hash=?').get(digest(token));
    return row ? { ...row, settings: JSON.parse(row.settings) } : null;
  }
  admit(device, ip, id, now = Date.now()) {
    const at = new Date(now).toISOString(), day = chinaClock(now).day, name = device?.id || 'admin';
    if (device) {
      const s = device.settings, used = this.totals(day,name);
      if (!s.enabled || !ipAllowed(ip,s.ips)) throw new BridgeError('device_denied', '设备已停用或 IP 不在允许范围。', 403);
      const minute = this.db.prepare('SELECT count(*) n FROM requests WHERE device=? AND at>=?').get(name,new Date(now-60000).toISOString()).n;
      if (s.dailyRequests && used.requests >= s.dailyRequests || s.dailyTokens && used.tokens >= s.dailyTokens || s.dailyCost && used.cost >= s.dailyCost || s.rpm && minute >= s.rpm || (this.active.get(name)||0) >= s.maxConcurrent) throw new BridgeError('device_quota', '设备已达到次数、Token、费用、频率或并发限额。', 429);
      if (s.dailyCost && used.unknown_cost) throw new BridgeError('device_cost_unknown', '存在未能估价的调用，无法继续执行费用限额；请先配置模型价格。', 429);
    }
    this.db.prepare('INSERT INTO requests(id,device,ip,day,at) VALUES(?,?,?,?,?)').run(id,name,ip,day,at);
    this.active.set(name,(this.active.get(name)||0)+1);
    return name;
  }
  finish(id, name, result) {
    this.db.prepare('UPDATE requests SET finished=1,success=?,tokens=?,cost=?,cost_known=?,bank_hit=? WHERE id=?').run(result.code===1?1:0,result.usage?.total_tokens||0,result.cost?.amount||0,result.cost?.known || !result.model_calls?1:0,result.source==='database'?1:0,id);
    this.active.set(name,Math.max(0,(this.active.get(name)||1)-1));
  }
  totals(day = chinaClock().day, device = null) {
    return this.db.prepare(`SELECT count(*) requests, coalesce(sum(success),0) success, coalesce(sum(tokens),0) tokens, coalesce(sum(cost),0) cost, coalesce(sum(CASE WHEN finished=1 AND cost_known=0 THEN 1 ELSE 0 END),0) unknown_cost, coalesce(sum(bank_hit),0) bank_hits FROM requests WHERE day=? ${device ? 'AND device=?' : ''}`).get(...(device?[day,device]:[day]));
  }
  analytics(day = chinaClock().day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BridgeError('invalid_day', '日期格式应为 YYYY-MM-DD。', 400);
    return { day, timezone:'Asia/Shanghai', totals:this.totals(day), ips:this.db.prepare('SELECT ip,count(*) requests,sum(tokens) tokens,sum(cost) cost FROM requests WHERE day=? GROUP BY ip ORDER BY requests DESC LIMIT 100').all(day), questions:this.db.prepare('SELECT count(*) total,sum(reviewed) reviewed FROM questions').get() };
  }
  lookup(q) {
    const row = this.db.prepare('SELECT result,reviewed FROM questions WHERE fingerprint=? AND enabled=1').get(questionKey(q));
    if (!row) return null;
    return { ...JSON.parse(row.result), source:'database', reviewed:!!row.reviewed, cached:true, usage:zero(), model_calls:0, cost:{known:true,amount:0,currency:'CNY',estimated:true} };
  }
  remember(q, result) {
    const input={title:q.title,type:q.kind,options:q.promptOptions,blank_count:q.blankCount,...(q.images.length?{images:q.images.map(i=>i.url)}:{})};
    this.db.prepare('INSERT OR IGNORE INTO questions(fingerprint,title,kind,input,result,source,updated) VALUES(?,?,?,?,?,?,?)').run(questionKey(q),q.title,q.kind,JSON.stringify(input),JSON.stringify({kind:result.kind,answer:result.answer,display_answer:result.display_answer,choices:result.choices,profile:result.profile,model:result.model}), 'ai',new Date().toISOString());
  }
  listQuestions(query='',page=1,kind='') {
    query = String(query).slice(0,200); page = Math.max(1,Math.min(100000,Number(page)||1));
    const where=[], args=[];
    if(kind) {where.push('q.kind=?');args.push(kind);}
    if(query) {
      if([...query].length>=3) { where.push('q.id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?)');args.push('"'+query.replace(/"/g,'""')+'"'); }
      else { where.push('instr(q.title,?)>0');args.push(query); }
    }
    const sql=where.length?' WHERE '+where.join(' AND '):'';
    return {total:this.db.prepare('SELECT count(*) n FROM questions q'+sql).get(...args).n,page,items:this.db.prepare('SELECT id,title,kind,enabled,reviewed,source,updated,result FROM questions q'+sql+' ORDER BY updated DESC LIMIT 30 OFFSET ?').all(...args,(page-1)*30).map(row=>({...row,result:JSON.parse(row.result)}))};
  }
  question(id) { const row=this.db.prepare('SELECT * FROM questions WHERE id=?').get(id); if(!row) throw new BridgeError('question_missing','题目不存在。',404); return {...row,input:JSON.parse(row.input),result:JSON.parse(row.result)}; }
  saveQuestion(value,id=null) {
    const q=runtime.normalize(value.input), parsed=runtime.answer(JSON.stringify({kind:q.kind,answer:value.answer,choices:value.choices}),q);
    const result={...parsed,profile:'question-bank',model:'manual'};
    const args=[questionKey(q),q.title,q.kind,JSON.stringify(value.input),JSON.stringify(result),value.enabled===false?0:1,value.reviewed===false?0:1,'manual',new Date().toISOString()];
    if(id) {this.question(id);this.db.prepare('UPDATE questions SET fingerprint=?,title=?,kind=?,input=?,result=?,enabled=?,reviewed=?,source=?,updated=? WHERE id=?').run(...args,id);}
    else this.db.prepare('INSERT INTO questions(fingerprint,title,kind,input,result,enabled,reviewed,source,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(...args);
    return {success:true};
  }
  removeQuestion(id) { this.db.prepare('DELETE FROM questions WHERE id=?').run(id); }
}
