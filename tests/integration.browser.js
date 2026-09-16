// Run on a disposable seeded workspace with a loopback GitLab fixture:
// approved project 42; MR 7 = current-head success, MR 8 = old-head success,
// MR 9 = 503. Never run against team planning data.
async page => {
 const check = (ok, message) => { if (!ok) throw new Error(message); };
 const saved = () => page.getByRole('status').filter({hasText:'Changes saved.'}).waitFor({timeout:15000});
 const save = async () => {await page.getByRole('button',{name:'Save changes',exact:true}).click();await saved();};
 const nav = async name => { await page.getByRole('navigation').getByRole('button',{name}).click(); };
 const board = () => page.evaluate(async () => (await fetch(`/api/v2/workspaces/${document.querySelector('#workspace').value}/board`)).json());
 const initial = await board(); const a=initial.items[0], b=initial.items[1];
 const card = item => page.locator(`[data-item="${item.id}"]`);
 await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all');
 await card(a).waitFor(); check(await card(a).locator('.avatar img').count()===1,'GitLab profile avatar not displayed');
 const openEditor = item => card(item).getByRole('button',{name:item.title,exact:true}).click();
 const openObservations = item => card(item).getByRole('button',{name:/^View GitLab details/}).click();
 const close = () => page.getByRole('button',{name:'Close editor',exact:true}).click();
 const attach = async (item,number,usePaste=false) => {
  await openEditor(item); await page.getByRole('button',{name:'＋ Add GitLab link',exact:true}).click();
  const scope=page.getByRole('combobox',{name:'Quick scope',exact:true});check(await scope.locator('option').count()===3,'quick MR scopes missing');
  if(usePaste){const base=initial.connector_instance.replace(/\/+$/,'');await page.getByLabel('Paste GitLab MR Link',{exact:true}).fill(`${base}/team/flux/-/merge_requests/${number}`);await page.getByRole('button',{name:'Get',exact:true}).click();await page.getByRole('status').filter({hasText:`Resolved team/flux · MR !${number}`}).waitFor();}
  else {const projectPicker=page.getByRole('group',{name:'Approved GitLab project',exact:true});await projectPicker.getByRole('button',{name:'Edit Approved GitLab project',exact:true}).click();await projectPicker.getByRole('checkbox',{name:'Flux · team/flux (#42)',exact:true}).check();await page.keyboard.press('Escape');const mrPicker=page.getByRole('group',{name:'Merge request',exact:true});await mrPicker.getByRole('button',{name:'Edit Merge request',exact:true}).click();await mrPicker.getByRole('searchbox',{name:'Filter merge request',exact:true}).fill(String(number));await mrPicker.getByRole('checkbox',{name:new RegExp(`^MR !${number} ·`)}).check();await page.keyboard.press('Escape');}
  await save(); await page.getByRole('button',{name:'Cancel',exact:true}).click();
 };
 const refresh = async number => {
  const row=page.getByRole('dialog').locator('.setup-row').filter({has:page.getByText(new RegExp(`^(MR !|Pipeline #)${number} · project`))});
  await row.getByRole('button',{name:'Refresh observation',exact:true}).click(); await saved();
 };
 await nav('Projects');
 await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit integration',exact:true}).click();
 check(await page.locator('.inline-maintenance-form').count()===1 && !await page.getByRole('dialog').isVisible(),'integration edit opened a dialog');
 await page.getByRole('button',{name:'Edit Approved GitLab projects',exact:true}).click();
 await page.getByRole('checkbox',{name:'Flux · team/flux (#42)',exact:true}).check();
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 check((await board()).integration.projects.length===0,'approval bypassed consent');
 await page.getByLabel('I approve this metadata visibility and any removals',{exact:true}).check();await save();
 await nav('Kanban board');
 await openEditor(a);await page.getByRole('button',{name:'＋ Add GitLab link',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();check(await page.getByRole('heading',{name:'Work item',exact:true}).count()===1,'closing MR dialog did not return to card editor');await close();
 await attach(a,7,true);await attach(a,8);await attach(a,9);
 await openEditor(b);await page.getByRole('button',{name:'Edit GitLab links',exact:true}).click();await page.getByRole('checkbox',{name:'MR !7 · project 42',exact:true}).check();await page.keyboard.press('Escape');await save();
 let current=await board();check(current.links.length===3&&current.links.find(l=>l.kind==='mr'&&l.number===7).items.length===2,'many-to-many registration failed');
 await openEditor(a);check(await page.getByRole('group',{name:'GitLab links',exact:true}).locator('.multi-select-chip').count()===3,'link dropdown associations missing');await close();
 const revision=current.workspace.revision;const itemRevision=current.items.find(i=>i.id===a.id).revision;
 await openObservations(a);await refresh(7);await refresh(8);await refresh(9);
 await page.getByRole('dialog').getByText('GitLab unavailable',{exact:true}).waitFor({timeout:10000});
 check(await page.getByRole('dialog').getByText(/pipeline success/).count()===1,'latest MR pipeline status missing');
 check(await page.getByRole('dialog').getByText(/pipeline unknown \(not current head\)/).count()===1,'old success represented current head');
 check(await page.getByRole('dialog').getByText('Fixture MR <script>never executed</script>',{exact:true}).count()>0,'provider title not rendered as text');
 current=await board();check(current.workspace.revision===revision&&current.items.find(i=>i.id===a.id).revision===itemRevision,'refresh changed planning revisions');
 check(current.items.every(i=>i.column_id===initial.items.find(old=>old.id===i.id).column_id),'refresh moved a card');
 check(await card(a).getByRole('link',{name:'MR !7',exact:true}).count()===1,'observed MR link is not on the card');
 check(await card(a).getByRole('button',{name:/^View GitLab details/}).count()===1,'card observation details link missing');
 await close();await openObservations(b);check(await page.getByRole('dialog').getByRole('link',{name:'MR !7',exact:true}).count()===1,'shared MR direct link missing');check(await page.getByRole('dialog').getByRole('link',{name:'Pipeline #1007',exact:true}).count()===1,'latest pipeline direct link missing');check(await page.getByRole('dialog').getByText(/Last successful refresh:/).count()===1,'precise refresh timing missing');check(await page.getByRole('dialog').getByText(/Latest refresh attempt:/).count()===1,'latest attempt timing missing');check(await page.getByRole('dialog').getByText(/pipeline success/).count()===1,'shared observation missing');
 check(await page.getByRole('button',{name:'Refresh observation',exact:true}).isDisabled(),'cooldown not shown');await close();
 await page.reload(); await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all'); await card(a).getByRole('button',{name:/^View GitLab details/}).waitFor({timeout:10000});
 check((await board()).links.find(l=>l.kind==='mr'&&l.number===7).observation.pipeline.state==='success','observation not persisted');
 for (const theme of ['light','dark']) {
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for (const width of [1440,768,390]) {
   await page.setViewportSize({width,height:1000});
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${theme} ${width}`);
   await card(a).getByRole('button',{name:/^View GitLab details/}).focus(); await page.keyboard.press('Enter');
   check(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),'dialog focus missing');
   await page.keyboard.press('Escape');
   check(await card(a).getByRole('button',{name:/^View GitLab details/}).evaluate(e=>e===document.activeElement),'dialog focus return');
  }
 }
 // Read-only controls are tested separately from server-side machine/role denial.
 await page.route('**/board',async route=>{const response=await route.fetch();const data=await response.json();data.role='viewer';await route.fulfill({response,json:data});});
 await page.reload(); await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all'); await card(a).getByRole('button',{name:/^View GitLab details/}).waitFor({timeout:10000});
 await openEditor(a);check(await page.getByRole('button',{name:'＋ Add GitLab link',exact:true}).isDisabled(),'viewer linking enabled');
 check(await page.getByRole('button',{name:'Edit GitLab links',exact:true}).isDisabled(),'viewer link associations enabled'); await close();
 await openObservations(a);check(await page.getByRole('button',{name:'Refresh observation',exact:true}).first().isDisabled(),'viewer refresh enabled');
 await close();await page.unroute('**/board');await page.reload();
 await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all'); await card(a).getByRole('button',{name:/^View GitLab details/}).waitFor({timeout:10000});
 await openEditor(b);await page.getByRole('button',{name:/^Remove MR !7 · project 42/}).click();await save();
 check((await board()).links.find(l=>l.kind==='mr'&&l.number===7).items.length===1,'unlink removed another item’s shared observation');
 await nav('Projects');
 await page.getByText('Flux · team/flux (#42)',{exact:true}).waitFor(); check(await page.locator('.integration-project-chip').filter({hasText:'Flux · team/flux (#42)'}).count()===1,'approved GitLab project chips are missing from the show state');
 await page.getByRole('button',{name:'Edit integration',exact:true}).click();
 await page.getByRole('button',{name:'Edit Approved GitLab projects',exact:true}).click();
 await page.getByRole('checkbox',{name:'Flux · team/flux (#42)',exact:true}).uncheck();
 await page.getByLabel('I approve this metadata visibility and any removals',{exact:true}).check();await save();
 current=await board();check(current.links.length===0&&current.items.length===initial.items.length,'revocation damaged planning or retained links');
 await nav('Members'); await page.getByRole('heading',{name:'Members',exact:true}).waitFor(); check(await page.getByRole('button',{name:'＋ Add member',exact:true}).count()===1,'admin member action is missing'); await page.getByRole('button',{name:'＋ Add member',exact:true}).click(); const userPicker=page.getByRole('group',{name:'GitLab user',exact:true}); await userPicker.getByRole('button',{name:'Edit GitLab user',exact:true}).click(); await userPicker.getByRole('checkbox',{name:'Fixture User 42 · @fixture-42 (#42)',exact:true}).check(); check(await page.getByLabel('GitLab subject',{exact:true}).inputValue()==='42' && !await page.getByLabel('GitLab subject',{exact:true}).isEditable(),'GitLab subject should be a read-only field'); check(await page.getByLabel('Workspace name',{exact:true}).inputValue()==='Fixture User 42','workspace name did not default to the GitLab profile name'); await page.keyboard.press('Escape'); await page.getByRole('button',{name:'Add member',exact:true}).click(); await saved(); let memberRow=page.locator('.maintenance-row').filter({hasText:'Fixture User 42'}); await memberRow.waitFor(); check(await memberRow.getByText('42',{exact:true}).count()===0,'member listing should not display the GitLab subject'); await memberRow.getByRole('button',{name:'Edit member',exact:true}).click(); await page.getByRole('combobox',{name:'Workspace role',exact:true}).selectOption('admin'); await page.getByRole('button',{name:'Save member',exact:true}).click(); await saved(); memberRow=page.locator('.maintenance-row').filter({hasText:'Fixture User 42'}); check(await memberRow.locator('.member-role-admin').textContent()==='Admin' && !(await memberRow.textContent()).includes('manage workspace'),'member role chip did not persist without permission text'); check(await memberRow.getByText('@fixture-42',{exact:true}).count()===1,'GitLab username is missing from the member listing'); await memberRow.getByRole('button',{name:'Remove member',exact:true}).click(); await page.getByRole('button',{name:'Remove member',exact:true}).click(); await saved(); check(await page.locator('.maintenance-row').filter({hasText:'Fixture User 42'}).count()===0,'member was not removed');
 return 'PASS: MR URL paste, quick scopes, fallback MR search, MR-only links with corresponding pipeline status, revision-safe link association/removal, revocation, explicit approval, shared observations, manual refresh, head-SHA safety, separate failures, persistent cache, workspace member add/role/remove, planning independence, viewer restrictions, six responsive keyboard layouts.';
}
