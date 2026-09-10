// Run on a disposable seeded workspace with a loopback GitLab fixture:
// approved project 42; MR 7 = current-head success, MR 8 = old-head success,
// MR 9 = 503, pipeline 23 = failed. Never run against team planning data.
async page => {
 const check = (ok, message) => { if (!ok) throw new Error(message); };
 const saved = () => page.getByRole('status').filter({hasText:'Changes saved.'}).waitFor({timeout:15000});
 const save = async () => {await page.getByRole('button',{name:'Save changes',exact:true}).click();await saved();};
 const board = () => page.evaluate(async () => (await fetch(`/api/v2/workspaces/${document.querySelector('#workspace').value}/board`)).json());
 const initial = await board(); const a=initial.items[0], b=initial.items[1];
 const card = item => page.locator(`[data-item="${item.id}"]`);
 const open = item => card(item).getByRole('button',{name:/^GitLab links/}).click();
 const close = () => page.getByRole('button',{name:'Close editor',exact:true}).click();
 const attach = async (item,kind,number) => {
  await open(item); await page.getByRole('button',{name:'＋ Link MR or pipeline',exact:true}).click();
  await page.getByRole('combobox',{name:'Approved GitLab project',exact:true}).selectOption('42');
  await page.getByRole('combobox',{name:'Object kind',exact:true}).selectOption(kind);
  await page.getByLabel('MR IID or pipeline ID',{exact:true}).fill(String(number)); await save();
 };
 const refresh = async number => {
  const row=page.getByRole('dialog').locator('.setup-row').filter({has:page.getByText(new RegExp(`^(MR !|Pipeline #)${number} · project`))});
  await row.getByRole('button',{name:'Refresh observation',exact:true}).click(); await saved();
 };
 await page.getByRole('button',{name:'Integration',exact:true}).click();
 await page.getByLabel('Approved numeric GitLab project IDs · comma separated',{exact:true}).fill('42');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 check((await board()).integration.projects.length===0,'approval bypassed consent');
 await page.getByLabel('I approve this metadata visibility and any removals',{exact:true}).check();await save();
 await attach(a,'mr',7);await attach(a,'mr',8);await attach(a,'pipeline',23);await attach(a,'mr',9);
 await attach(b,'mr',7);
 let current=await board();check(current.links.length===4&&current.links.find(l=>l.kind==='mr'&&l.number===7).items.length===2,'many-to-many registration failed');
 const revision=current.workspace.revision;const itemRevision=current.items.find(i=>i.id===a.id).revision;
 await open(a);await refresh(7);await refresh(8);await refresh(23);await refresh(9);
 await page.getByRole('dialog').getByText('GitLab unavailable',{exact:true}).waitFor({timeout:10000});
 check(await page.getByRole('dialog').getByText(/pipeline unknown \(not current head\)/).count()===1,'old success represented current head');
 check(await page.getByRole('dialog').getByText(/pipeline failed/).count()===1,'failure hidden by another success');
 check(await page.getByRole('dialog').getByText('Fixture MR <script>never executed</script>',{exact:true}).count()>0,'provider title not rendered as text');
 current=await board();check(current.workspace.revision===revision&&current.items.find(i=>i.id===a.id).revision===itemRevision,'refresh changed planning revisions');
 check(current.items.every(i=>i.column_id===initial.items.find(old=>old.id===i.id).column_id),'refresh moved a card');
 await close();await open(b);check(await page.getByRole('dialog').getByText(/pipeline success/).count()===1,'shared observation missing');
 check(await page.getByRole('button',{name:'Refresh observation',exact:true}).isDisabled(),'cooldown not shown');await close();
 await page.reload();await card(a).getByRole('button',{name:/^GitLab links/}).waitFor({timeout:10000});
 check((await board()).links.find(l=>l.kind==='mr'&&l.number===7).observation.pipeline.state==='success','observation not persisted');
 for (const theme of ['light','dark']) {
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for (const width of [1440,768,390]) {
   await page.setViewportSize({width,height:1000});
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${theme} ${width}`);
   await card(a).getByRole('button',{name:/^GitLab links/}).focus(); await page.keyboard.press('Enter');
   check(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),'dialog focus missing');
   await page.keyboard.press('Escape');
   check(await card(a).getByRole('button',{name:/^GitLab links/}).evaluate(e=>e===document.activeElement),'dialog focus return');
  }
 }
 // Read-only controls are tested separately from server-side machine/role denial.
 await page.route('**/board',async route=>{const response=await route.fetch();const data=await response.json();data.role='viewer';await route.fulfill({response,json:data});});
 await page.reload();await card(a).getByRole('button',{name:/^GitLab links/}).waitFor({timeout:10000});
 await open(a);check(await page.getByRole('button',{name:'＋ Link MR or pipeline',exact:true}).isDisabled(),'viewer linking enabled');
 check(await page.getByRole('button',{name:'Refresh observation',exact:true}).first().isDisabled(),'viewer refresh enabled');
 await close();await page.unroute('**/board');await page.reload();
 await card(a).getByRole('button',{name:/^GitLab links/}).waitFor({timeout:10000});
 await open(b);await page.getByRole('button',{name:'Unlink…',exact:true}).click();await save();
 check((await board()).links.find(l=>l.kind==='mr'&&l.number===7).items.length===1,'unlink removed another item’s shared observation');
 await page.getByRole('button',{name:'Integration',exact:true}).click();
 await page.getByLabel('Approved numeric GitLab project IDs · comma separated',{exact:true}).fill('');
 await page.getByLabel('I approve this metadata visibility and any removals',{exact:true}).check();await save();
 current=await board();check(current.links.length===0&&current.items.length===initial.items.length,'revocation damaged planning or retained links');
 return 'PASS: unlink/revocation, explicit approval, shared MR and pinned-pipeline links, manual refresh, head-SHA safety, separate failures, persistent cache, planning independence, viewer restrictions, six responsive keyboard layouts.';
}
