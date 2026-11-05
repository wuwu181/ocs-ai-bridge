export function installFeatures({ $, node, api, state, dirty, toast, view }) {
  const main=document.querySelector('main'), nav=document.querySelector('nav');
  const pages={ bank:'自建题库', devices:'设备与限额', network:'网络与共享', billing:'费用与统计' };
  function page(id,title,html) {
    nav.append(node('button',{class:'nav','data-view':id,text:title}));
    const section=node('section',{id:`view-${id}`,class:'view hidden'});
    section.innerHTML=`<div class="page-heading"><div><p class="eyebrow">WORKSPACE</p><h1>${title}</h1></div></div>`+html;
    main.insertBefore(section,main.querySelector('footer'));
  }
  page('bank',pages.bank,`<article class="card"><p class="muted">答题先精确查本机题库，未命中再调用 AI；成功答案自动保存并标为待核对。搜索使用 SQLite FTS5 三字索引，自动回填只使用题型、题干、选项顺序和图片均一致的记录。</p><div class="form-grid"><label>搜索题干<input id="bank-search" placeholder="输入关键词，支持中文"></label><label>题型<select id="bank-kind"><option value="">全部题型</option><option value="single">单选</option><option value="multiple">多选</option><option value="judgement">判断</option><option value="completion">填空</option><option value="subjective">解答</option></select></label></div><div class="form-actions"><button id="bank-find" class="button">搜索</button><button id="bank-add" class="button primary">添加题目</button></div><div class="checkbox-row"><label><input id="bank-enabled" type="checkbox">答题优先查库</label><label><input id="bank-autosave" type="checkbox">AI 答案自动入库</label><label><input id="bank-reviewed" type="checkbox">只复用已核对答案</label></div><p id="bank-count" class="muted"></p><div class="table-wrap"><table><thead><tr><th>题目</th><th>类型 / 状态</th><th>答案</th><th>操作</th></tr></thead><tbody id="bank-rows"></tbody></table></div><div class="form-actions"><button id="bank-prev" class="button">上一页</button><span id="bank-page"></span><button id="bank-next" class="button">下一页</button></div></article>`);
  page('devices',pages.devices,`<article class="card"><p class="muted">每台设备使用独立令牌，只能答题，不能进入管理接口。日限额按 Asia/Shanghai 零点重置。Token / 金额在模型返回后结算，可能超出最后一笔调用；这不是预付费支付系统。复制同一份配置的设备共用限额。</p><button id="device-add" class="button primary">添加设备</button><div id="device-list" class="model-grid"></div></article>`);
  page('network',pages.network,`<article class="card"><div class="form-grid"><label>监听地址（保存后重启）<select id="network-host"><option value="127.0.0.1">127.0.0.1 · 仅本机</option><option value="0.0.0.0">0.0.0.0 · 局域网 / IPv4</option><option value="::">:: · IPv6 / 双栈依系统</option><option value="localhost">localhost</option><option value="::1">::1 · 本机 IPv6</option></select></label><label>公网根地址（可选）<input id="network-base" placeholder="https://ai.example.com"></label></div><label>可信反向代理 IP（每行一个，默认留空）<textarea id="network-proxies" rows="2" placeholder="127.0.0.1"></textarea></label><p class="muted">填写你自己 HTTPS 反向代理的真实 IP 后，才读取它添加的 X-Forwarded-For 最右一项。默认使用 TCP 对端 IP，防止客户端伪造。不要把整个网段设为代理。</p><div class="form-actions"><button id="network-use" class="button primary">应用网络设置</button><button id="network-refresh" class="button">刷新本机地址</button></div><div id="network-addresses"></div><p class="footnote">同一路由器下：监听改为 0.0.0.0，保存并重启，在系统防火墙允许对应端口。跨公网还需要你自己的可达公网 IP / 域名、路由器端口转发或反向代理；此页面不会自动修改路由器或防火墙。给其他设备导出时选择独立设备令牌。</p></article>`);
  page('billing',pages.billing,`<article class="card"><div class="form-grid"><label>统计日期（北京时间）<input id="billing-day" type="date"></label><div class="form-actions"><button id="billing-refresh" class="button">查询统计</button></div></div><div id="billing-totals" class="metrics"></div><h2>IP 用量</h2><div class="table-wrap"><table><thead><tr><th>IP</th><th>请求</th><th>Token</th><th>预估人民币</th></tr></thead><tbody id="billing-ips"></tbody></table></div></article><article class="card"><h2>DeepSeek 价格快照</h2><p class="muted">核对日期 2026-11-05，人民币 / 百万 Token。仅 api.deepseek.com 的已知模型自动使用官方价，其他服务需在下方设置各接口价格。北京时间工作日 09:00–12:00、14:00–18:00 为高峰，其他时段半价；节假日以你维护的日期表为准。没有缓存拆分时按未命中价估算，没有 usage 时不估价。</p><label>模型价格 JSON<textarea id="billing-prices" rows="6" spellcheck="false"></textarea></label><label>各接口自定义价格 JSON（键为接口标识；本地免费模型可设 input/output/cached 为0）<textarea id="billing-custom" rows="4" spellcheck="false" placeholder='{"ollama":{"input":0,"output":0,"cached":0,"peakMultiplier":1}}'></textarea></label><label>中国法定节假日 / 放假日（YYYY-MM-DD，每行一个）<textarea id="billing-holidays" rows="4"></textarea></label><p class="muted">已预置2026年假期。跨年使用前请更新日期表；预测费用不是服务商账单。价格修改仅影响之后的请求，不重算历史费用。</p><button id="billing-use" class="button primary">应用价格设置</button></article>`);
  const deviceExport=node('label',{text:'使用设备令牌（分享给其他设备时必选）'},[node('select',{id:'export-device'},[node('option',{value:'',text:'本机管理令牌 · 仅本人本机'})])]);
  $('export-base').parentElement.after(deviceExport);
  const check=node('label',{class:'checkbox-row'},[node('input',{id:'test-database',type:'checkbox'}),'试答也优先查自建题库（默认直接测试模型）']);
  $('test-form').append(check);
  const dialog=node('dialog',{id:'bank-dialog'});
  dialog.innerHTML=`<form id="bank-form"><div class="dialog-heading"><h2>编辑题库记录</h2><button type="button" id="bank-close" class="button">关闭</button></div><label>题干<textarea id="bank-title" rows="4" required></textarea></label><label>题型<select id="bank-type"><option value="single">单选</option><option value="multiple">多选</option><option value="judgement">判断</option><option value="completion">填空</option><option value="subjective">解答</option></select></label><label>选项（每行一个）<textarea id="bank-options" rows="3"></textarea></label><label>答案<textarea id="bank-answer" rows="5" required></textarea></label><p class="muted">单选填 B，多选填 ACD，判断填 对/错；多空填 JSON 数组如 ["第一空","第二空"]。解答题保留完整正文与换行。</p><label>图片（可选，重新选择会替换原图）<input id="bank-images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><p id="bank-image-count" class="muted"></p><label class="checkbox-row"><input id="bank-clear-images" type="checkbox">移除原图片</label><div class="checkbox-row"><label><input id="bank-record-enabled" type="checkbox" checked>启用答案</label><label><input id="bank-record-reviewed" type="checkbox" checked>已人工核对</label></div><p id="bank-error" class="error-text"></p><button class="button primary">保存到题库</button></form>`;
  document.body.append(dialog);
  let bankPage=1, bankTotal=0, editId=null, oldInput={};
  const textLines=value=>value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const money=value=>'¥'+Number(value||0).toFixed(6);
  function on(id,fn) { $(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>toast(e.message))); }
  async function loadBank() {
    const data=await api('/admin/questions?'+new URLSearchParams({q:$('bank-search').value,kind:$('bank-kind').value,page:bankPage}));
    bankTotal=data.total;$('bank-count').textContent=`共 ${data.total} 题`;$('bank-page').textContent=`第 ${bankPage} 页`;
    $('bank-prev').disabled=bankPage===1;$('bank-next').disabled=bankPage*30>=bankTotal;
    $('bank-rows').replaceChildren(...data.items.map(row=>node('tr',{},[
      node('td',{class:'question-summary',text:row.title}),node('td',{text:({single:'单选',multiple:'多选',judgement:'判断',completion:'填空',subjective:'解答'}[row.kind]||row.kind)+' / '+(!row.enabled?'停用':row.reviewed?'已核对':'AI待核对')}),
      node('td',{class:'question-summary',text:row.result.display_answer}),node('td',{},[
        node('button',{class:'text-button',text:'编辑',onclick:()=>editBank(row.id).catch(e=>toast(e.message))}),
        node('button',{class:'text-button danger',text:'删除',onclick:async()=>{if(confirm('删除这条题库记录？')) {try{await api('/admin/questions/'+row.id,{method:'DELETE'});await loadBank();}catch(e){toast(e.message);}}}})
      ])
    ])));
  }
  async function editBank(id=null) {
    editId=id;const row=id?await api('/admin/questions/'+id):null;oldInput=row?.input||{};
    $('bank-title').value=oldInput.title||'';$('bank-type').value=row?.kind==='unknown'?'subjective':row?.kind||'single';
    $('bank-options').value=Array.isArray(oldInput.options)?oldInput.options.join('\n'):oldInput.options||'';
    $('bank-answer').value=row?(row.kind==='subjective'?row.result.display_answer:row.result.answer):'';
    $('bank-record-enabled').checked=row?!!row.enabled:true;$('bank-record-reviewed').checked=row?!!row.reviewed:true;
    $('bank-images').value='';$('bank-clear-images').checked=false;$('bank-image-count').textContent=`原记录 ${oldInput.images?.length||0} 张图`;
    $('bank-error').textContent='';dialog.showModal();
  }
  on('bank-find',()=>{bankPage=1;return loadBank();});on('bank-prev',()=>{bankPage--;return loadBank();});on('bank-next',()=>{bankPage++;return loadBank();});on('bank-add',()=>editBank());on('bank-close',()=>dialog.close());
  $('bank-form').addEventListener('submit',async e=>{
    e.preventDefault();try{
      const input={...oldInput,title:$('bank-title').value,type:$('bank-type').value,options:textLines($('bank-options').value)};
      if($('bank-clear-images').checked) input.images=[];
      const files=Array.from($('bank-images').files);
      if(files.some(f=>f.size>5*1024**2)||files.length>20)throw new Error('每图最多5MiB，最多20张。');
      if(files.length) input.images=await Promise.all(files.map(f=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f);} )));
      let answer=$('bank-answer').value;
      if(input.type==='completion') {try{answer=JSON.parse(answer);}catch{answer=[answer];}if(!Array.isArray(answer))answer=[String(answer)];}
      await api('/admin/questions'+(editId?'/'+editId:''),{method:editId?'PUT':'POST',body:JSON.stringify({input,answer,enabled:$('bank-record-enabled').checked,reviewed:$('bank-record-reviewed').checked})});
      dialog.close();await loadBank();toast('题库已保存，后续查题即时生效。');
    }catch(error){$('bank-error').textContent=error.message;}
  });
  for(const [id,key] of [['bank-enabled','enabled'],['bank-autosave','autoSave'],['bank-reviewed','reviewedOnly']]) $(id).addEventListener('change',()=>{state().config.bank[key]=$(id).checked;dirty();});
  let deviceRows=[];
  async function loadDevices() {
    const data=await api('/admin/devices');deviceRows=data.items;
    const select=$('export-device'), selected=select.value;
    select.replaceChildren(node('option',{value:'',text:'本机管理令牌 · 仅本人本机'}),...data.items.filter(x=>x.settings.enabled).map(x=>node('option',{value:x.id,text:x.name})));
    select.value=selected;
    $('device-list').replaceChildren(...data.items.map(d=>node('article',{class:'model-card'},[
      node('h2',{text:d.name}),node('p',{text:d.settings.enabled?'已启用':'已停用'}),node('p',{text:`今日请求 ${d.usage.requests} / ${d.settings.dailyRequests||'不限'} · Token ${d.usage.tokens} · ${money(d.usage.cost)}`}),
      node('p',{class:'muted',text:`RPM ${d.settings.rpm||'不限'} · 并发 ${d.settings.maxConcurrent} · 未估价 ${d.usage.unknown_cost} 次`}),
      node('div',{class:'model-actions'},[
        node('button',{class:'text-button',text:'编辑限额',onclick:()=>editDevice(d)}),
        node('button',{class:'text-button',text:d.settings.enabled?'停用':'启用',onclick:async()=>{try{await api('/admin/devices/'+d.id,{method:'PUT',body:JSON.stringify({name:d.name,settings:{...d.settings,enabled:!d.settings.enabled}})});await loadDevices();}catch(e){toast(e.message);}}}),
        node('button',{class:'text-button',text:'导出连接配置',onclick:()=>{select.value=d.id;view('connect');toast('已选择此设备，请填写它能访问的服务地址后下载。');}})
      ])
    ])));
  }
  const deviceDialog=node('dialog');deviceDialog.innerHTML=`<form id="device-form"><h2>设备与限额</h2><label>设备名称<input id="device-name" required maxlength="80"></label><div class="form-grid"><label>每天请求次数（0不限）<input id="device-requests" type="number" min="0" value="1000"></label><label>每天Token（0不限）<input id="device-tokens" type="number" min="0" value="0"></label><label>每天预估人民币（0不限）<input id="device-cost" type="number" min="0" step="0.01" value="0"></label><label>每分钟次数（0不限）<input id="device-rpm" type="number" min="0" value="30"></label><label>设备并发<input id="device-concurrent" type="number" min="1" value="1"></label></div><label>允许IP（每行一个IP或IPv4网段，留空不限）<textarea id="device-ips" rows="2" placeholder="192.168.1.0/24"></textarea></label><label>允许接口标识（每行一个，留空使用默认路由）<textarea id="device-profiles" rows="2"></textarea></label><p id="device-error" class="error-text"></p><div class="form-actions"><button class="button primary">保存设备</button><button id="device-close" type="button" class="button">关闭</button></div></form>`;document.body.append(deviceDialog);
  let deviceEditing=null;
  function editDevice(d=null) {deviceEditing=d;const s=d?.settings||{};$('device-name').value=d?.name||'';for(const [id,key,def] of [['requests','dailyRequests',1000],['tokens','dailyTokens',0],['cost','dailyCost',0],['rpm','rpm',30],['concurrent','maxConcurrent',1]]) $('device-'+id).value=s[key]??def;$('device-ips').value=(s.ips||[]).join('\n');$('device-profiles').value=(s.profiles||[]).join('\n');$('device-error').textContent='';deviceDialog.showModal();}
  on('device-add',()=>editDevice());on('device-close',()=>deviceDialog.close());
  $('device-form').addEventListener('submit',async e=>{e.preventDefault();try{const settings={...deviceEditing?.settings};for(const [id,key] of [['requests','dailyRequests'],['tokens','dailyTokens'],['cost','dailyCost'],['rpm','rpm'],['concurrent','maxConcurrent']])settings[key]=Number($('device-'+id).value);settings.ips=textLines($('device-ips').value);settings.profiles=textLines($('device-profiles').value);await api('/admin/devices'+(deviceEditing?'/'+deviceEditing.id:''),{method:deviceEditing?'PUT':'POST',body:JSON.stringify({name:$('device-name').value,settings})});deviceDialog.close();await loadDevices();toast('设备已保存，可在连接 OCS 导出独立配置。');}catch(error){$('device-error').textContent=error.message;}});
  async function network() {const data=await api('/admin/network');$('network-addresses').replaceChildren(node('p',{text:'当前监听：'+data.host}),...data.addresses.map(address=>node('p',{text:'局域网地址候选：'+address})));}
  on('network-refresh',network);on('network-use',()=>{const c=state().config;c.server.host=$('network-host').value;c.network.publicBase=$('network-base').value.trim();c.network.trustedProxies=textLines($('network-proxies').value);dirty();toast('已应用，点击顶部保存配置；监听地址变化后重启。');});
  async function billing() {
    const data=await api('/admin/analytics'+($('billing-day').value?'?day='+$('billing-day').value:''));$('billing-day').value=data.day;
    $('billing-totals').replaceChildren(...[['请求',data.totals.requests],['Token',data.totals.tokens],['费用预估',money(data.totals.cost)],['题库命中',data.totals.bank_hits],['未估价调用',data.totals.unknown_cost]].map(([label,value])=>node('article',{class:'metric'},[node('span',{text:label}),node('strong',{text:value})])));
    $('billing-ips').replaceChildren(...data.ips.map(row=>node('tr',{},[row.ip,row.requests,row.tokens,money(row.cost)].map(text=>node('td',{text})))));
  }
  on('billing-refresh',billing);
  on('billing-use',()=>{const c=state().config;c.billing.prices=JSON.parse($('billing-prices').value);c.billing.holidays=textLines($('billing-holidays').value);const custom=JSON.parse($('billing-custom').value||'{}');for(const id of Object.keys(custom))if(!c.profiles[id])throw new Error('接口不存在：'+id);for(const [id,p] of Object.entries(c.profiles)) {if(custom[id])p.pricing=custom[id];else delete p.pricing;}dirty();toast('价格已应用，点击顶部保存后对新请求生效。');});
  return {
    async show(name) {if(name==='bank')await loadBank();if(name==='devices'||name==='connect')await loadDevices();if(name==='network')await network();if(name==='billing')await billing();},
    load() {const c=state().config;if(!c)return;for(const [id,key] of [['bank-enabled','enabled'],['bank-autosave','autoSave'],['bank-reviewed','reviewedOnly']])$(id).checked=c.bank[key];$('network-host').value=c.server.host;$('network-base').value=c.network.publicBase;$('network-proxies').value=c.network.trustedProxies.join('\n');$('billing-prices').value=JSON.stringify(c.billing.prices,null,2);$('billing-custom').value=JSON.stringify(Object.fromEntries(Object.entries(c.profiles).filter(([,p])=>p.pricing).map(([id,p])=>[id,p.pricing])),null,2);$('billing-holidays').value=c.billing.holidays.join('\n');}
  };
}
