// Execute with playwright-browser run-code on an EMPTY disposable workspace.
async (page) => {
 page.setDefaultTimeout(10000);
 // Keep both drop targets visible; avoid testing browser auto-scroll geometry.
 await page.setViewportSize({width:1440,height:1800});
 const check = (ok, message) => { if (!ok) throw new Error(message); };
 const saved = async () => { await page.getByRole('status').filter({hasText:'Changes saved.'}).waitFor(); };
 const save = async () => { await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved(); };
 const board = () => page.evaluate(async () => (await fetch(`/api/v2/workspaces/${document.querySelector('#workspace').value}/board`)).json());
 const drag = async (source, target, position) => {
  await source.dragTo(target, {targetPosition:position});
 };
 await page.getByRole('heading',{name:'Kanban board',exact:true}).waitFor();
 check((await board()).items.length===0,'requires an empty test workspace');
 for (const name of ['Bug', 'Delivery']) {
  await page.getByRole('button',{name:'Labels',exact:true}).click();
  await page.getByRole('button',{name:'＋ New label',exact:true}).click();
  await page.getByLabel('Label name',{exact:true}).fill(name); await save();
 }
 await page.getByRole('button',{name:'Members',exact:true}).click();
 await page.getByRole('button',{name:'Edit name',exact:true}).click();
 await page.getByLabel('Display name',{exact:true}).fill('Alex Planner'); await save();
 for (const name of ['Drag first', 'Drag second']) {
  await page.getByRole('button',{name:'＋ New item',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill(name);
  await page.getByRole('combobox',{name:'Assignee',exact:true}).selectOption({label:'Alex Planner'});
  await page.getByRole('listbox',{name:'Labels · select multiple with Ctrl / Command',exact:true}).selectOption(['Bug','Delivery']); await save();
 }
 const initial=await board(); const first=initial.items[0], second=initial.items[1]; const ready=initial.columns[0], doing=initial.columns[1];
 const card = id => page.locator(`[data-item="${id}"]`);
 const column = id => page.locator(`[data-column="${id}"]`);
 const handle = id => card(id);
 check(await card(first.id).getByText('Alex Planner',{exact:true}).count()===1,'raw subject shown instead of name');
 await drag(handle(second.id), card(first.id), {x:16,y:8}); await saved();
 check((await board()).items[0].id===second.id,'card before-drop did not reorder');
 let box=await card(first.id).boundingBox();
 await drag(handle(second.id), card(first.id), {x:16,y:box.height-8}); await saved();
 check((await board()).items[0].id===first.id,'card after-drop did not reorder');
 await drag(handle(first.id),column(doing.id),{x:16,y:100}); await saved();
 check((await board()).items.find(i=>i.id===first.id).column_id===doing.id,'cross-list drop failed');
 // Set a real WIP policy and verify that rejected drops never move local cards.
 await page.getByRole('button',{name:'Board setup',exact:true}).click();
 await page.locator('.setup-row').filter({has:page.getByText(doing.name,{exact:true})}).getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByLabel('WIP limit · 0 means unlimited').fill('1'); await save();
 await drag(handle(second.id),column(doing.id).locator('.column-head'),{x:16,y:8});
 await page.getByRole('status').filter({hasText:'WIP limit'}).waitFor();
 check(await column(ready.id).locator(`[data-item="${second.id}"]`).count()===1,'rejected drop rearranged local card');
 check((await board()).items.find(i=>i.id===second.id).column_id===ready.id,'WIP drop persisted');
 await drag(column(doing.id).locator('.column-head'),column(ready.id),{x:8,y:16}); await saved();
 check((await board()).columns[0].id===doing.id,'list before-drop failed');
 box=await column(ready.id).boundingBox();
 await drag(column(doing.id).locator('.column-head'),column(ready.id),{x:box.width-8,y:16}); await saved();
 check((await board()).columns[0].id===ready.id,'list after-drop failed');
 await page.reload(); await page.getByRole('button',{name:'Drag first',exact:true}).waitFor();
 check(await column(doing.id).locator(`[data-item="${first.id}"]`).count()===1,'drop did not survive reload');
 check(await card(first.id).getAttribute('draggable')==='true','card body is not draggable');
 check(await column(doing.id).locator('.column-head').getAttribute('draggable')==='true','column header is not draggable');
 // Project filtering changes visibility, never project classification or order.
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('none');
 await drag(handle(first.id),card(second.id),{x:16,y:8}); await saved();
 check((await board()).items.every(i=>i.project_id===''),'project selection drop changed classification');
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('all');
 // A drop begun against stale data must conflict, not overwrite another tab.
 const other=await page.context().newPage(); await other.goto(page.url());
 await other.getByRole('button',{name:'Drag first',exact:true}).click();
 await other.getByLabel('Title',{exact:true}).fill('Drag first updated');
 await other.getByRole('button',{name:'Save changes',exact:true}).click();
 await other.getByRole('status').filter({hasText:'Changes saved.'}).waitFor(); await other.close();
 await drag(handle(second.id),column(doing.id),{x:16,y:100});
 await page.getByRole('status').filter({hasText:'planning changed'}).waitFor();
 check((await board()).items.find(i=>i.id===second.id).column_id===ready.id,'stale drop persisted');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByRole('button',{name:'Drag first updated',exact:true}).waitFor();
 // Rename applies to existing assignments; archive then delete also updates archived work.
 await page.getByRole('button',{name:'Labels',exact:true}).click();
 await page.locator('.setup-row').filter({has:page.getByText('Bug',{exact:true})}).getByRole('button',{name:'Rename',exact:true}).click();
 await page.getByLabel('Label name',{exact:true}).fill('Defect'); await save();
 check((await board()).items.every(i=>i.labels.includes('Defect')&&!i.labels.includes('Bug')),'rename lost assignments');
 await page.getByRole('button',{name:'Drag first updated',exact:true}).click();
 check((await page.getByRole('listbox',{name:'Labels · select multiple with Ctrl / Command',exact:true}).locator('option:checked').allTextContents()).length===2,'multi-selection not preserved');
 await page.getByRole('button',{name:'Archive item',exact:true}).click();
 await page.getByRole('button',{name:'Archive item',exact:true}).click(); await saved();
 await page.getByRole('button',{name:'Labels',exact:true}).click();
 await page.locator('.setup-row').filter({has:page.getByText('Defect',{exact:true})}).getByRole('button',{name:'Delete…',exact:true}).click();
 await page.getByRole('button',{name:'Delete label',exact:true}).click(); await saved();
 check((await board()).items.every(i=>!i.labels.includes('Defect')),'delete retained archived assignment');
 await page.getByRole('button',{name:'Drag second',exact:true}).click();
 await page.getByRole('listbox',{name:'Labels · select multiple with Ctrl / Command',exact:true}).selectOption([]); await save();
 check((await board()).items.find(i=>i.id===second.id).labels.length===0,'cannot clear labels');
 // Check viewer affordances independently of the backend authorization tests.
 await page.route('**/board',async route=>{const response=await route.fetch();const data=await response.json();data.role='viewer';await route.fulfill({response,json:data});});
 await page.reload(); await page.getByRole('button',{name:'Drag second',exact:true}).waitFor();
 check(await card(second.id).getByRole('button',{name:/^Drag card/}).count()===0,'explicit card drag handle remains');
 check(await card(second.id).getAttribute('draggable')==='false','viewer draggable');
 check(await column(doing.id).locator('.column-head').getAttribute('draggable')==='false','viewer column draggable');
 check(await page.getByRole('button',{name:'Labels',exact:true}).isDisabled(),'viewer label management enabled');
 await page.unroute('**/board'); await page.reload();
 await page.getByRole('button',{name:'Drag second',exact:true}).waitFor();
 for(const theme of ['light','dark']) {
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const width of [1440,768,390]) {
   await page.setViewportSize({width,height:1000});
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${theme} ${width}`);
   await page.getByRole('button',{name:'Drag second',exact:true}).focus(); await page.keyboard.press('Enter');
   await page.getByRole('listbox',{name:'Labels · select multiple with Ctrl / Command',exact:true}).focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
   check(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),'label keyboard focus');
   await page.keyboard.press('Escape');
   check(await page.getByRole('button',{name:'Drag second',exact:true}).evaluate(e=>e===document.activeElement),'editor focus return');
  }
 }
 return 'PASS: implicit card/header before/after drops, cross-list and filtered movement, WIP/stale rejection, persistence, display names, label CRUD/multi-select/archive propagation, viewer controls, responsive keyboard workflows.';
}
