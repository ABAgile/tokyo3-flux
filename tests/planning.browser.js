// Execute with playwright-browser run-code against a fresh seeded TEST workspace.
// This mutates test data, including sprint closure. Never use a team workspace.
async (page) => {
 page.setDefaultTimeout(10000);
 const check = (ok, message) => { if (!ok) throw new Error(message); };
 const saved = async () => { await page.getByRole('status').filter({hasText:'Changes saved.'}).waitFor(); };
 const nav = async name => { await page.getByRole('navigation').getByRole('button',{name}).click(); };
 const title = 'Browser spanning item';
 await page.getByRole('heading',{name:'Kanban board',exact:true}).waitFor();
 // Project classification is optional and managed without creating a new board.
 await page.getByRole('button',{name:'Projects',exact:true}).click();
 await page.getByRole('button',{name:'＋ New project',exact:true}).click();
 await page.getByLabel('Project name').fill('Cross-project stream');
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 for (const [label, color] of [['type::review', '#ffcc00'], ['priority::high', '#145a42']]) {
  await page.getByRole('button',{name:'Labels',exact:true}).click();
  await page.getByRole('button',{name:'＋ New label',exact:true}).click();
  await page.getByLabel('Label name',{exact:true}).fill(label);
  check(await page.getByRole('radio').count()===64,'label palette does not have 64 colors');
  await page.getByRole('radio',{name:color,exact:true}).check();
  await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 }
 await page.getByRole('button',{name:'＋ New item',exact:true}).click();
 check(await page.getByRole('dialog').getByRole('combobox',{name:'Project',exact:true}).inputValue() === '', 'new item required a project');
 await page.getByLabel('Title',{exact:true}).fill(title);
 await page.getByLabel('Description',{exact:true}).fill('One item across projects and sprints. <script>alert("never HTML")</script>');
 await page.getByRole('listbox',{name:'Labels · select multiple with Ctrl / Command',exact:true}).selectOption(['type::review', 'priority::high']);
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('none');
 await page.getByRole('button',{name:title,exact:true}).waitFor();
 check(await page.getByRole('heading',{name:/No project ·/}).count()===0, 'project grouping should be removed');
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('all');
 await page.getByRole('combobox',{name:'Label',exact:true}).selectOption('type::review');
 check(await page.getByRole('button',{name:title,exact:true}).count()===1,'label filtering hides or duplicates card');
 check(await page.locator('.card .card-top .card-title').filter({hasText:title}).count()===1,'title is not the card header');
 check(await page.locator('.card .card-description').count()===0,'description is displayed on card');
 check(await page.locator('.card .label-badge').filter({hasText:'type::review'}).first().evaluate(e => e.style.backgroundColor !== ''),'label color is not displayed');
 check(await page.locator('.card .card-id').count()===0,'native card ID is displayed');
 check(await page.getByLabel('Priority',{exact:true}).count()===0,'priority field is still displayed');
 await page.getByRole('combobox',{name:'Label',exact:true}).selectOption('all');
 // The item editor keeps keyboard-accessible column movement, and WIP counts all projects together.
 await page.getByRole('button',{name:title,exact:true}).click();
 await page.getByRole('combobox',{name:'Board column',exact:true}).selectOption({label:'In progress'}); await save();
 await page.reload(); await page.getByRole('button',{name:title,exact:true}).waitFor();
 await page.getByRole('button',{name:title,exact:true}).click();
 check(await page.getByRole('combobox',{name:'Board column',exact:true}).locator('option:checked').textContent()==='In progress','move did not persist');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:"Define the team's acceptance criteria",exact:true}).click();
 await page.getByRole('combobox',{name:'Board column',exact:true}).selectOption({label:'In progress'});
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('status').filter({hasText:'WIP limit'}).waitFor();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // A single card can belong to both sprints without duplication.
 await nav('Backlog'); await page.getByRole('button',{name:title,exact:true}).click();
 await page.getByRole('dialog').getByRole('combobox',{name:'Project',exact:true}).selectOption({label:'Cross-project stream'});
 await page.getByRole('listbox',{name:'Open sprints · select multiple with Ctrl / Command',exact:true}).selectOption([{label:'Sprint 1 · Planning foundations (active)'},{label:'Sprint 2 · Delivery signals (planned)'}]);
 await page.getByLabel('Decision note (optional)',{exact:true}).fill('Work spans both sprints');
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 check(await page.getByRole('button',{name:title,exact:true}).count()===0,'scheduled item remained in backlog');
 await nav('Kanban board');
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption({label:'Cross-project stream'});
 check(await page.getByRole('button',{name:title,exact:true}).count()===1,'project filtering duplicates or hides card');
 await page.getByText('1 shown · 3/3 WIP',{exact:true}).waitFor();
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('all');
 await page.getByRole('button',{name:title,exact:true}).click();
 check((await page.getByRole('listbox',{name:'Open sprints · select multiple with Ctrl / Command',exact:true}).locator('option:checked').allTextContents()).length===2,'multi-sprint membership not persisted');
 await page.getByLabel('Title',{exact:true}).fill('Retained stale draft');
 const other=await page.context().newPage(); other.setDefaultTimeout(10000); await other.goto(page.url());
 await other.getByRole('button',{name:title,exact:true}).click();
 await other.getByLabel('Title',{exact:true}).fill('Concurrent accepted edit');
 await other.getByRole('button',{name:'Save changes',exact:true}).click();
 await other.getByRole('status').filter({hasText:'Changes saved.'}).waitFor();
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'planning changed'}).waitFor();
 check(await page.getByLabel('Title',{exact:true}).inputValue()==='Retained stale draft','draft lost');
 await page.getByRole('button',{name:'Cancel',exact:true}).click(); await other.close();
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByRole('button',{name:'Concurrent accepted edit',exact:true}).waitFor();
 // Concurrent active workspace sprints are allowed; close only the first one.
 await nav('Sprints'); await page.getByRole('button',{name:'Start sprint',exact:true}).click(); await saved();
 check(await page.getByText('ACTIVE SPRINT',{exact:true}).count()===2,'concurrent active sprints rejected');
 const first=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Sprint 1 · Planning foundations',exact:true})});
 await first.getByRole('button',{name:'Close sprint',exact:true}).click();
 await page.getByRole('combobox',{name:'Also assign unfinished work to',exact:true}).selectOption('');
 await page.getByLabel('Closing decision / rationale').fill('Close first sprint; retain next sprint assignment');
 await page.getByRole('dialog').getByRole('button',{name:'Close sprint',exact:true}).click(); await saved();
 check(await page.getByText('CLOSED SPRINT',{exact:true}).count()===1,'closed sprint missing');
 check(await page.getByText('ACTIVE SPRINT',{exact:true}).count()===1,'other sprint altered');
 await nav('Kanban board'); await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('active');
 await page.getByRole('button',{name:'Concurrent accepted edit',exact:true}).click();
 await page.getByText('Closed sprint history (read-only): Sprint 1 · Planning foundations',{exact:true}).waitFor();
 check((await page.getByRole('listbox',{name:'Open sprints · select multiple with Ctrl / Command',exact:true}).locator('option:checked').allTextContents()).length===1,'remaining sprint lost/duplicated');
 // Clearing project classification does not change sprint membership or history.
 await page.getByRole('dialog').getByRole('combobox',{name:'Project',exact:true}).selectOption('');
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('none');
 await page.getByRole('button',{name:'Concurrent accepted edit',exact:true}).click();
 await page.getByRole('button',{name:'Archive item',exact:true}).click();
 await page.getByRole('heading',{name:'Archive work item',exact:true}).waitFor();
 await page.getByRole('button',{name:'Archive item',exact:true}).click(); await saved();
 await nav('Archive'); await page.getByRole('button',{name:'Restore item',exact:true}).click(); await saved();
 await nav('History'); await page.getByText('item · restore',{exact:true}).waitFor();
 await page.getByText('Close first sprint; retain next sprint assignment',{exact:true}).waitFor();
 await nav('Kanban board'); await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('all');
 await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all');
 await page.getByRole('button',{name:'Board setup',exact:true}).click();
 await page.getByRole('button',{name:'＋ Add column',exact:true}).click();
 await page.getByLabel('Column name').fill('Waiting for feedback');
 await page.getByLabel('Lifecycle category').selectOption('doing');
 await page.getByLabel('WIP limit · 0 means unlimited').fill('2');
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 await page.getByRole('heading',{name:'Waiting for feedback',exact:true}).waitFor();
 for(const theme of ['light','dark']){
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
  for(const width of [1440,768,390]){
   await page.setViewportSize({width,height:1000});
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${theme} ${width}`);
   await page.getByRole('button',{name:'＋ New item',exact:true}).focus(); await page.keyboard.press('Enter');
   check(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),'modal focus');
   await page.keyboard.press('Escape');check(await page.getByRole('button',{name:'＋ New item',exact:true}).evaluate(e=>e===document.activeElement),'focus return');
  }
 }
 return 'PASS: workspace board, optional projects and toolbar filtering, shared WIP, multi-sprint persistence, concurrent active sprints, closure isolation/history, stale edits, archive/restore, six accessible responsive layouts.';
}
