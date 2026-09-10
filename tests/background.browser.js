// Disposable seeded workspace, automatic refresh enabled (30s), mock GitLab:
// project 42 / MR7: first fetch current head success, subsequent fetch newer MR
// with an old-head pipeline. MR8 always returns a valid observation.
async page => {
 const check=(ok,message)=>{if(!ok)throw new Error(message);};
 const saved=()=>page.getByRole('status').filter({hasText:'Changes saved.'}).waitFor({timeout:15000});
 const save=async()=>{await page.getByRole('button',{name:'Save changes',exact:true}).click();await saved();};
 const board=()=>page.evaluate(async()=> (await fetch(`/api/v2/workspaces/${document.querySelector('#workspace').value}/board`)).json());
 const until=async predicate=>{const deadline=Date.now()+60000;while(Date.now()<deadline){if(predicate(await board()))return;await page.waitForTimeout(500);}throw new Error('background observation did not converge');};
 const initial=await board();const item=initial.items[0];
 check(initial.refresh_seconds===30,'worker configuration missing');
 await page.getByRole('button',{name:'Integration',exact:true}).click();
 await page.getByLabel('Approved numeric GitLab project IDs · comma separated',{exact:true}).fill('42');
 await page.getByLabel('I approve this metadata visibility and any removals',{exact:true}).check();await save();
 for(const number of [7,8]){
  await page.locator(`[data-item="${item.id}"]`).getByRole('button',{name:/^GitLab links/}).click();
  await page.getByRole('button',{name:'＋ Link MR or pipeline',exact:true}).click();
  await page.getByRole('combobox',{name:'Approved GitLab project',exact:true}).selectOption('42');
  await page.getByLabel('MR IID or pipeline ID',{exact:true}).fill(String(number));await save();
 }
 const linked=await board();const revision=linked.workspace.revision;const ids=linked.links.map(l=>l.id);
 await until(b=>b.links.length===2&&b.links.every(l=>l.outcome==='ok'&&l.observation));
 let current=await board();check(current.workspace.revision===revision,'worker changed planning revision');
 const first=current.links.find(l=>l.number===7);check(first.observation.pipeline.state==='success','initial head not observed');
 // No manual observation refresh: the idle card summary must receive the cache.
 await page.locator(`[data-observation="${first.id}"]`).filter({hasText:/pipeline success/}).waitFor({timeout:20000});
 const post=(headers,data)=>page.evaluate(async args=>(await fetch('/webhooks/gitlab',{method:'POST',headers:{'Content-Type':'application/json',...args.headers},body:JSON.stringify(args.data)})).status,{headers,data});
 const body={object_kind:'merge_request',project:{id:42},object_attributes:{iid:7,state:'merged',title:'Never trust webhook planning values',sha:'forged'}};
 const headers={'X-Gitlab-Event':'Merge Request Hook','X-Gitlab-Token':'fixture-webhook-secret-0000000000000000','X-Gitlab-Webhook-UUID':'browser-delivery-one'};
 let response=await post({...headers,'X-Gitlab-Token':'wrong'},body);check(response===401,'unauthenticated webhook accepted');
 for(let i=0;i<2;i++){response=await post(headers,body);check(response===202,'webhook not accepted');}
 current=await board();check(current.links.find(l=>l.number===7).refresh_pending,'target not queued');check(!current.links.find(l=>l.number===8).refresh_pending,'unrelated MR queued');
 response=await post(headers,{...body,extra:'different payload'});check(response===409,'delivery ID collision accepted');
 response=await post({...headers,'X-Gitlab-Webhook-UUID':'older-delivery'},{...body,object_attributes:{iid:7,state:'closed'}});check(response===202,'out-of-order hint rejected');
 await until(b=>b.links.some(l=>l.number===7&&l.observation?.head_sha==='head-b'));
 current=await board();const next=current.links.find(l=>l.number===7);
 check(next.observation.pipeline.state==='unknown'&&!next.observation.pipeline.current_head,'old pipeline success represents new head');
 check(next.observation.mr_state==='opened','webhook supplied MR state was persisted');
 check(current.workspace.revision===revision&&current.items[0].column_id===item.column_id,'webhook/worker changed planning');
 check(ids.every(id=>current.links.some(l=>l.id===id)),'link identity changed');
 // Polling must not steal a draft or overwrite planning changed elsewhere.
 await page.getByRole('button',{name:item.title,exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Retained draft during background refresh');
 await page.waitForTimeout(16000);check(await page.getByLabel('Title',{exact:true}).inputValue()==='Retained draft during background refresh','background poll replaced draft');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'layout overflow');await page.locator(`[data-item="${item.id}"]`).getByRole('button',{name:/^GitLab links/}).focus();await page.keyboard.press('Enter');await page.getByText(/Background refresh: about every 30 seconds/).waitFor({timeout:10000});check(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth),'dialog overflow');await page.keyboard.press('Escape');}}
 return 'PASS: automatic initial observation, idle UI update, authenticated targeted hints, replay/collision handling, out-of-order convergence, head-SHA safety, planning/draft preservation, six responsive keyboard layouts.';
}
