// Execute with playwright-browser run-code against a fresh seeded TEST workspace.
// This mutates test data, including sprint closure. Never use a team workspace.
async (page) => {
 page.setDefaultTimeout(10000);
 const check = (ok, message) => { if (!ok) throw new Error(message); };
 const saved = async () => { await page.getByRole('status').filter({hasText:'Changes saved.'}).waitFor(); };
 const save = async () => { await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved(); };
 const chooseMulti = async (name, values) => { await page.getByRole('button',{name:`Edit ${name}`,exact:true}).click(); for (const value of values) await page.getByRole('checkbox',{name:value,exact:true}).check(); await page.keyboard.press('Escape'); };
 const nav = async name => { await page.getByRole('navigation').getByRole('button',{name}).click(); };
 const title = 'Browser spanning item';
 await page.getByRole('heading',{name:'Kanban board',exact:true}).waitFor();
 const initialColumnCount = await page.locator('.column').count(); const listToggle = page.getByRole('button',{name:'List',exact:true}); const boardToggle = page.getByRole('button',{name:'Board',exact:true}); check(await listToggle.count()===1 && await boardToggle.count()===1,'planning presentation toggle is missing'); check(await boardToggle.getAttribute('aria-pressed')==='true' && await listToggle.getAttribute('aria-pressed')==='false','Kanban is not the default presentation');
 await listToggle.click(); await page.getByRole('heading',{name:'Planning list',exact:true}).waitFor(); check(await page.locator('.list-section').count()===initialColumnCount,'list does not preserve board column order/count'); const listHeaders = await page.locator('.list-table-head .list-table-heading').allTextContents(); check(listHeaders.join('|')==='Title|Project|Assignee|Labels|Sprints|Links / Status','list table columns are missing'); const listItemIDs = await page.locator('.list-row').evaluateAll(rows => { const ids = rows.map(row => row.dataset.item); return ids.length === new Set(ids).size; }); check(listItemIDs,'list duplicates work items'); check((await page.locator('.list-section').first().locator('.list-section-summary').textContent()).includes('shown ·'),'list section summary is missing filtered/WIP counts'); const firstListRow = page.locator('.list-row').first(); await firstListRow.focus(); await page.keyboard.press('Enter'); await page.locator('.item-detail-pane').waitFor(); check(await page.locator('.item-detail-pane').getByLabel('Title',{exact:true}).count()===1,'list selection did not open the detail pane'); check(await firstListRow.getAttribute('aria-current')==='true' && await firstListRow.evaluate(row => row.classList.contains('is-selected')),'selected list row is not marked'); const visibleListFields = await firstListRow.locator(':scope > .list-cell').evaluateAll(cells => cells.filter(cell => getComputedStyle(cell).display !== 'none').map(cell => cell.dataset.label)); check(visibleListFields.join('|')==='Title|Project|Assignee|Labels','detail pane did not compact the list columns'); await page.keyboard.press('Escape'); check(await firstListRow.evaluate(row => row === document.activeElement),'detail close did not return focus to its originating row'); await boardToggle.click(); await page.getByRole('heading',{name:'Kanban board',exact:true}).waitFor();
 const initialScopeLabels = await page.getByRole('combobox',{name:'Scope',exact:true}).locator('option').allTextContents();
 check(await page.getByRole('combobox',{name:'Scope',exact:true}).inputValue()==='active','home scope is not Active sprints');
 check(initialScopeLabels.slice(0,3).join('|')==='Active sprints|Backlog|All open work','scope options are in the wrong order');
 check(await page.getByRole('navigation').getByRole('button',{name:'Backlog',exact:true}).count()===0,'standalone backlog view is still visible');
 check(await page.locator('.topbar').count()===0,'header topbar is still visible');
 check(await page.locator('#mode').count()===0,'sidebar planning badge is still visible');
 check(await page.locator('.workspace-label-row #new-workspace').count()===1 && await page.locator('#new-workspace span[aria-hidden="true"]').textContent()==='＋','create workspace is not a plus icon beside Workspace'); check(await page.locator('.workspace-label-row #refresh').count()===1 && await page.locator('#refresh span[aria-hidden="true"]').textContent()==='↻','refresh is not an icon beside Workspace');
 check(await page.locator('#breadcrumb').count()===0,'workspace eyebrow is still visible');
 check(await page.locator('.sidebar-account #identity').count()===1 && await page.locator('.sidebar-account a[href="/auth/logout"]').count()===1,'identity is not beside sign out');
 check(await page.locator('.sidebar-session > #theme').count()===1 && await page.locator('.sidebar-session > .sidebar-account').count()===1,'theme and account are not combined');
 check(await page.locator('#theme span[aria-hidden="true"]').count()===1,'theme switch is not an icon');
 const themeIcon = page.locator('#theme span[aria-hidden="true"]'); const initialThemeIcon = await themeIcon.textContent(); await page.locator('#theme').click(); check(await themeIcon.textContent() !== initialThemeIcon,'theme icon did not toggle'); await page.locator('#theme').click();
 check(await page.locator('nav button > span:last-child').evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left))).size === 1),'navigation labels are not aligned');
 check(await page.locator('nav button > span:last-child').allTextContents().then(labels => labels.indexOf('Labels') > labels.indexOf('Members')),'Labels is not after Members');
 check(await page.getByText('Native planning, independent of GitLab.',{exact:true}).count()===0,'native planning sidebar help text is still visible');
 check(await page.getByText('YOUR WORK. YOUR SOURCE OF TRUTH.',{exact:true}).count()===0,'sidebar slogan is still visible');
 check(await page.locator('.sidebar-foot').evaluate(foot => getComputedStyle(foot).textAlign === 'right'),'sidebar footer is not right aligned');
 const sprintBox = page.locator('#sprint-summary .sprint-panel').first(); const sprintMetricLabels = await sprintBox.locator(':scope > .metrics .metric').evaluateAll(metrics => metrics.map(metric => metric.lastElementChild?.textContent)); check(sprintMetricLabels.join('|')==='In scope|Done|Blocked','sprint metrics use the expected labels');
 await page.setViewportSize({width:1024,height:1000}); const compactSprintLayout = await page.locator('#sprint-summary .sprint-panel').first().evaluate(panel => { const info = panel.querySelector(':scope > .sprint-info')?.getBoundingClientRect(); const metrics = panel.querySelector(':scope > .metrics')?.getBoundingClientRect(); const title = panel.querySelector(':scope > .sprint-info > .sprint-title-row > .sprint-title-copy')?.getBoundingClientRect(); const actions = panel.querySelector(':scope > .sprint-actions')?.getBoundingClientRect(); if (!info || !metrics || !title || !actions) return false; const titleAndActionsSeparate = title.right <= actions.left || actions.right <= title.left || title.bottom <= actions.top || actions.bottom <= title.top; return info.bottom <= metrics.top && titleAndActionsSeparate; }); check(compactSprintLayout && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'sprint summary overlaps or overflows at the narrow desktop content width'); await page.setViewportSize({width:390,height:1000}); const mobileSprintLayout = await sprintBox.evaluate(panel => { const actions = [...panel.querySelectorAll(':scope > .sprint-actions .action-icon')].map(button => button.getBoundingClientRect()); const noActionOverlap = actions.every((box, index) => actions.slice(index + 1).every(other => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top)); return noActionOverlap && panel.scrollWidth <= panel.clientWidth + 1; }); check(mobileSprintLayout && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'sprint actions overlap or overflow on a mobile layout'); await page.setViewportSize({width:1280,height:1000}); const wideMetricPlacement = await sprintBox.evaluate(panel => { const info = panel.querySelector(':scope > .sprint-info')?.getBoundingClientRect(); const metrics = panel.querySelector(':scope > .metrics')?.getBoundingClientRect(); const actions = panel.querySelector(':scope > .sprint-actions')?.getBoundingClientRect(); const panelBox = panel.getBoundingClientRect(); const paddingRight = Number.parseFloat(getComputedStyle(panel).paddingRight) || 0; return !!info && !!metrics && !!actions && metrics.left >= info.right && actions.right >= panelBox.right - paddingRight - 1 && actions.bottom <= metrics.top; }); check(wideMetricPlacement,'sprint metrics did not move beside the summary on a wide layout');
 await sprintBox.getByRole('button',{name:'Show burn down',exact:true}).click();
 await sprintBox.getByRole('heading',{name:'Remaining work',exact:true}).waitFor();
 const fullWidthBurndown = await sprintBox.evaluate(panel => { const panelBox = panel.getBoundingClientRect(); const burndown = panel.querySelector(':scope > .burndown-panel')?.getBoundingClientRect(); const style = getComputedStyle(panel); const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0); return !!burndown && Math.abs(burndown.left - panelBox.left - (Number.parseFloat(style.paddingLeft) || 0)) < 1 && Math.abs(burndown.width - panelBox.width + horizontalPadding) < 1; }); check(fullWidthBurndown,'burn down panel does not use the sprint panel width');
 await sprintBox.getByRole('button',{name:'Hide burn down',exact:true}).click();
 check(await page.locator('#sprint-summary .burndown-panel').count() === 0,'burn down did not collapse');
 await page.locator('#sprint-summary .sprint-panel').first().getByRole('button',{name:'Show burn down',exact:true}).click();
 await page.locator('#sprint-summary .burndown-svg').waitFor();
 check(await page.locator('#sprint-summary .burndown-chart-row .burndown-filter-condition').count() === 1,'burn down filter condition is not beside the figure');
 const daily = page.locator('#sprint-summary .burndown-data'); await daily.locator('summary').click();
 check(await daily.locator('thead th').first().textContent() === 'Metric','daily values are not metric rows');
 check((await daily.locator('tbody th').allTextContents()).join('|') === 'In scope|Remaining','daily values rows are not horizontal metrics');
 check(await page.getByLabel('Project',{exact:true}).isVisible(),'project filter is missing from burn down');
 check(await page.getByLabel('Assignee',{exact:true}).isVisible(),'assignee filter is missing from burn down');
 await page.getByRole('combobox',{name:'Assignee',exact:true}).selectOption('none');
 await page.locator('#sprint-summary .burndown-svg').waitFor();
 await page.getByRole('combobox',{name:'Assignee',exact:true}).selectOption('all');
 await page.locator('#sprint-summary .burndown-svg').waitFor();
 // Project classification is optional and managed without creating a new board.
 await nav('Projects');
 await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();
 const projectSections = page.locator('.maintenance-sections'); check(await projectSections.evaluate(sections => sections.firstElementChild?.querySelector('h2')?.textContent === 'GitLab integration'),'GitLab integration should be shown first'); check(await projectSections.evaluate(sections => getComputedStyle(sections).gridTemplateColumns.split(' ').length === 1),'Projects page still uses a two-column layout'); const workspaceProjects = projectSections.locator(':scope > section').nth(1); check(await workspaceProjects.evaluate(section => !section.classList.contains('maintenance-section') && getComputedStyle(section).borderStyle === 'none'),'workspace projects still uses the maintenance container'); const projectFilterBar = page.locator('#content .filter-bar'); check(await projectFilterBar.count()===1 && await projectFilterBar.evaluate(bar => bar.closest('.filter-slot')?.previousElementSibling?.querySelector('h2')?.textContent === 'Workspace projects' && getComputedStyle(bar).display === 'flex'),'project filters are not in a horizontal bar below the title'); const projectFilterLabels = await projectFilterBar.locator('label').allTextContents(); check(projectFilterLabels.join('|')==='Assignee|Label|Search','project filters are in the wrong order'); const projectCount = projectFilterBar.locator('.filter-bar-count'); check(await projectCount.count()===1,'project count is missing from the filter line');
 await page.getByRole('button',{name:'＋ New project',exact:true}).click();
 await page.getByLabel('Project name').fill('Cross-project stream');
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 const projectListFilter = page.getByRole('searchbox',{name:'Search',exact:true}); const projectAssigneeFilter = page.getByRole('combobox',{name:'Assignee',exact:true}); const projectLabelFilter = page.getByRole('combobox',{name:'Label',exact:true}); check(await projectListFilter.count()===1 && await projectAssigneeFilter.count()===1 && await projectLabelFilter.count()===1,'workspace project filters are missing'); const assigneeOptions = await projectAssigneeFilter.locator('option').allTextContents(); check(assigneeOptions.slice(0,2).join('|')==='Any assignee|Unassigned','assignee filter options are missing'); const labelOptions = await projectLabelFilter.locator('option').allTextContents(); check(labelOptions.slice(0,2).join('|')==='Any label|No labels','label filter options are missing'); await projectAssigneeFilter.selectOption('none'); check(await projectAssigneeFilter.inputValue()==='all','the project assignee select should reset to Any after adding a filter'); check(await page.locator('#content .filter-chips .filter-chip').count()===1,'the project assignee filter is not shown as a chip'); await projectAssigneeFilter.selectOption('all'); check(await page.locator('#content .filter-chips .filter-chip').count()===0,'choosing Any assignee did not clear the project filter chips'); const projectRow = page.locator('.maintenance-row').filter({hasText:'Cross-project stream'});
 await projectListFilter.fill('cross-project'); await projectRow.waitFor(); check(await page.locator('.maintenance-row').count()===1 && await projectCount.textContent()==='1 project','workspace project filtering returned the wrong rows or count'); await projectAssigneeFilter.selectOption('none'); await page.getByText('No projects match “cross-project” and the current filters.',{exact:true}).waitFor(); check(await projectRow.count()===0 && await projectCount.textContent()==='0 projects','assignee filtering did not exclude projects without matching work'); await projectAssigneeFilter.selectOption('all'); await projectRow.waitFor(); check(await projectCount.textContent()==='1 project','project count did not recover after clearing assignee filter'); await projectLabelFilter.selectOption('none'); await page.getByText('No projects match “cross-project” and the current filters.',{exact:true}).waitFor(); check(await projectRow.count()===0 && await projectCount.textContent()==='0 projects','label filtering did not exclude projects without matching work'); await projectLabelFilter.selectOption('all'); await projectRow.waitFor(); await projectListFilter.fill('does-not-exist'); await page.getByText('No projects match “does-not-exist”.',{exact:true}).waitFor(); await projectListFilter.fill('');
 await projectRow.getByRole('button',{name:'View scope',exact:true}).click();
 await page.getByRole('heading',{name:'Planning list',exact:true}).waitFor();
 const projectFilter = page.getByRole('combobox',{name:'Project',exact:true}); const projectID = new URL(page.url()).searchParams.get('project'); check(await projectFilter.inputValue()==='all','the project select should reset to All after adding a filter'); check(await page.locator('#filter-chips .filter-chip').count()===1,'the project lens is not shown as a filter chip'); const scopeFilter = page.getByRole('combobox',{name:'Scope',exact:true});
 check(projectID !== 'all','View scope did not select the project lens'); check(await scopeFilter.inputValue()==='all','project lens did not default to All open work');
 const projectURL = new URL(page.url()); check(projectURL.searchParams.get('mode')==='list' && projectURL.searchParams.get('project')===projectID && projectURL.searchParams.get('scope')==='all','project view state is not shareable in the URL');
 const projectSummary = page.locator('#project-summary'); check(await projectSummary.isVisible(),'project summary is missing'); const projectSummaryText = await projectSummary.textContent(); for (const label of ['In scope','Done','Blocked','Unscheduled','Active sprint coverage']) check(projectSummaryText.includes(label),`project summary is missing ${label}`); check(await projectSummary.locator('.project-summary-head > .muted').count()===0,'project summary still shows a redundant muted totals line'); const projectMetricLabels = await projectSummary.locator('.project-summary-metrics .metric').evaluateAll(metrics => metrics.map(metric => metric.lastElementChild?.textContent)); check(projectMetricLabels.join('|')==='In scope|Done|Blocked|Unscheduled','project summary metrics are not aligned with sprint metrics');
 await page.getByRole('button',{name:'＋ New item',exact:true}).click(); const inheritedProject = page.getByRole('dialog').getByRole('group',{name:'Project',exact:true}); check(await inheritedProject.locator('input[name="project_id"]:checked').inputValue()===projectID,'new item did not inherit the project lens'); await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Board',exact:true}).click(); await page.getByRole('heading',{name:'Kanban board',exact:true}).waitFor(); check(new URL(page.url()).searchParams.get('mode')==='board','Board presentation was not persisted');
 await projectFilter.selectOption('all'); await projectFilter.selectOption(projectID); check(await page.getByRole('heading',{name:'Kanban board',exact:true}).count()===1,'Kanban project filtering changed the presentation');
 await page.getByRole('button',{name:'List',exact:true}).click(); await page.getByRole('heading',{name:'Planning list',exact:true}).waitFor(); check(new URL(page.url()).searchParams.get('mode')==='list','List presentation was not persisted');
 await page.reload(); await page.getByRole('heading',{name:'Planning list',exact:true}).waitFor(); check(new URL(page.url()).searchParams.get('project')===projectID && await page.locator('#filter-chips .filter-chip').count()===1 && await scopeFilter.inputValue()==='all','reloading the project URL lost its filters');
 await page.getByRole('button',{name:'Board',exact:true}).click(); await projectFilter.selectOption('all'); await scopeFilter.selectOption('active');
 for (const [label, color] of [['type::review', '#ffcc00'], ['priority::review', '#145a42']]) {
  await nav('Labels');
  await page.getByRole('heading',{name:'Labels',exact:true}).waitFor();
  check(await page.locator('#planning-filters').isHidden(),'label maintenance still shows work filters');
  await page.getByRole('button',{name:'＋ New label',exact:true}).click();
  await page.getByLabel('Label name',{exact:true}).fill(label);
  check(await page.getByRole('radio').count()===64,'label palette does not have 64 colors');
  await page.getByRole('radio',{name:color,exact:true}).check();
  await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 }
 await nav('Kanban board');
 await page.getByRole('button',{name:'＋ New item',exact:true}).click();
 const itemDialog = page.getByRole('dialog'); const projectField = itemDialog.getByRole('group',{name:'Project',exact:true}); const assigneeField = itemDialog.getByRole('group',{name:'Assignee',exact:true});
 check(await itemDialog.getByRole('combobox',{name:'Move to',exact:true}).isVisible(), 'Move to select is missing');
 check(await projectField.locator('input[name="project_id"]:checked').inputValue() === '', 'new item required a project');
 for (const field of [projectField, assigneeField]) {
  check(await field.getByRole('button',{name:`Edit ${await field.locator('.multi-select-label').textContent()}`,exact:true}).count()===1,'selection field is missing display mode');
  check(await field.locator('.multi-select-menu').isHidden(),'selection menu is not initially hidden');
  check(await field.locator('input[type="checkbox"]:checked').count()===1,'single selection field has multiple values');
 }
 await projectField.getByRole('button',{name:'Edit Project',exact:true}).click();
 check(await projectField.locator('.multi-select-menu').isVisible(),'Edit Project did not reveal its selection box');
 await page.keyboard.press('Escape');
 await page.getByLabel('Title',{exact:true}).fill(title);
 const description = page.getByLabel('Description',{exact:true}); const descriptionEditor = description.locator('..');
 check(await descriptionEditor.locator('.markdown-preview').isVisible(),'description does not open in Preview');
 const editDescription = descriptionEditor.getByRole('button',{name:'Edit description',exact:true}); check(await editDescription.count()===1,'preview mode should only show the edit button'); check(await editDescription.textContent()==='Edit','preview mode should show the Edit text'); check(await descriptionEditor.locator('.markdown-toolbar > :not([hidden])').count()===1,'preview mode should hide formatting controls');
 await editDescription.click(); check(await description.evaluate(input => getComputedStyle(input).boxShadow !== 'none'),'Markdown edit focus border is missing');
 await description.fill('One item across projects and sprints. **Bold acceptance** and [safe link](https://example.com).\n\n- [x] Preview works\n\n| Feature | Value |\n| :--- | ---: |\n| Safe HTML | yes |\n\n<script>alert("never HTML")</script>\n\n[unsafe](javascript:alert(1))');
 const previewDescription = descriptionEditor.getByRole('button',{name:'Preview description',exact:true}); check(await previewDescription.count()===1,'editing mode is missing the preview button'); check(await previewDescription.textContent()==='Preview','editing mode should show the Preview text');
 check(await descriptionEditor.locator('.markdown-toolbar button').first().getAttribute('aria-label')==='Preview description','preview button is not first in the editing toolbar');
 check(await descriptionEditor.locator('.markdown-divider:not([hidden])').count()===5,'Markdown tool groups are not separated');
 check(await descriptionEditor.locator('.markdown-editor').evaluate(editor => editor.firstElementChild?.classList.contains('markdown-toolbar') && editor.children[1]?.tagName === 'TEXTAREA'),'toolbar is not fused to the input');
 check(await descriptionEditor.locator('.markdown-toolbar').evaluate(toolbar => toolbar.scrollWidth === toolbar.clientWidth),'Markdown toolbar scrolls at the standard editor width');
 check(await descriptionEditor.locator('.markdown-tool').first().evaluate(tool => tool.getBoundingClientRect().width >= 28),'Markdown icons are too small to click');
 check(await descriptionEditor.getByRole('button',{name:'Task list',exact:true}).count()===1,'Markdown toolbar is missing task lists');
 await description.evaluate(input => input.setSelectionRange(input.value.length, input.value.length)); await descriptionEditor.getByRole('button',{name:'Insert table',exact:true}).click();
 check((await description.inputValue()).includes('| Header 1 | Header 2 |'),'insert table did not add Markdown');
 await previewDescription.click();
 check(await descriptionEditor.locator('.markdown-preview strong').textContent()==='Bold acceptance','description Markdown was not rendered');
 check(await descriptionEditor.locator('.markdown-preview a').count()===1,'safe Markdown link was not rendered');
 check(await descriptionEditor.locator('.markdown-preview .markdown-task input:checked').count()===1,'task-list Markdown was not rendered');
 check(await descriptionEditor.locator('.markdown-preview table').count()>=2,'table Markdown was not rendered');
 check((await descriptionEditor.locator('.markdown-preview').textContent()).includes('[unsafe](javascript:alert(1))'),'unsafe Markdown link was rendered as HTML');
 check(await descriptionEditor.locator('script').count()===0,'description raw HTML was executed');
 await chooseMulti('Labels', ['type::review', 'priority::review']);
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all');
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('none');
 check(await page.getByRole('button',{name:title,exact:true}).count()===0, 'project filter should exclude multi-project cards from No project');
 check(await page.getByRole('heading',{name:/No project ·/}).count()===0, 'project grouping should be removed');
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('all');
 await page.getByRole('combobox',{name:'Label',exact:true}).selectOption('type::review');
 check(await page.getByRole('button',{name:title,exact:true}).count()===1,'label filtering hides or duplicates card');
 check(await page.locator('.card .card-top .card-title').filter({hasText:title}).count()===1,'title is not the card header'); check(await page.locator('.card .card-top .card-title').filter({hasText:title}).evaluate(button => Math.abs(button.getBoundingClientRect().width - button.parentElement.getBoundingClientRect().width) < 1),'card title does not fill card-top');
 check(await page.locator('.card .card-description').count()===0,'description is displayed on card');
 check(await page.locator('.card .label-badge').filter({hasText:'type::review'}).first().evaluate(e => e.style.backgroundColor !== ''),'label color is not displayed');
 check(await page.getByRole('combobox',{name:'Label',exact:true}).evaluate(e => Number.parseInt(getComputedStyle(e.closest('label')).fontWeight, 10) >= 600),'input labels are not bold');
 check(await page.getByRole('combobox',{name:'Label',exact:true}).evaluate(e => Number.parseInt(getComputedStyle(e).fontWeight, 10) === 400),'input control text is not normal');
 check(await page.locator('.card .card-id').count()===0,'native card ID is displayed');
 check(await page.getByLabel('Priority',{exact:true}).count()===0,'priority field is still displayed');
 await page.getByRole('combobox',{name:'Label',exact:true}).selectOption('all');
 // The item editor keeps keyboard-accessible column movement, and WIP counts all projects together.
 await page.getByRole('button',{name:title,exact:true}).click();
 const itemLayout = page.locator('.item-editor-layout');
 check(await itemLayout.locator('.item-editor-primary').getByLabel('Title',{exact:true}).count()===1,'title is not in the primary editor pane');
 check(await itemLayout.locator('.item-editor-primary .markdown-field').count()===1,'description is not in the primary editor pane');
 check(await itemLayout.locator('.item-editor-controls select[name="column_id"]').count()===1,'Move to select is not in the control pane');
 check(await itemLayout.locator('.item-editor-controls .multi-select-field').count()===6,'selection controls are not in the control pane');
 const controlOrder = await itemLayout.locator('.item-editor-controls').evaluate(controls => [...controls.children].flatMap(child => { if (child.classList.contains('multi-select-field')) return [child.querySelector('.multi-select-label')?.textContent.trim()]; if (child.matches('label')) return [child.textContent.trim()]; return []; })); check(controlOrder.join('|') === 'Assignee|Labels|Project|Open sprints|Depends on|GitLab links|Move to','item controls are in the wrong order'); check(await itemLayout.locator('.item-editor-divider').count()===1,'Move to divider is missing');
 check(await page.locator('.item-editor-form .dialog-foot').getByRole('button',{name:'Archive item',exact:true}).count()===1,'archive action is not in the fixed footer');
 check(await page.locator('.item-editor-form #fields').evaluate(fields => getComputedStyle(fields).overflowY === 'auto'),'item fields do not scroll independently');
 check(await itemLayout.locator('.item-editor-primary > .item-comments').count()===1,'comments are not in the primary pane'); check(await itemLayout.locator('.item-editor-primary').evaluate(primary => { const attachments = primary.querySelector('.item-attachments'); const comments = primary.querySelector('.item-comments'); return !!attachments && !!comments && !!(attachments.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING); }),'attachments should appear before comments'); check(await page.locator('#editor-form').evaluate(form => { const box = form.getBoundingClientRect(); return box.left >= 15 && box.top >= 15 && box.right <= innerWidth - 15 && box.bottom <= innerHeight - 15 && getComputedStyle(form).boxShadow !== 'none'; }),'editor frame loses its viewport margin or visual boundary');
 const attachments = itemLayout.locator('.item-attachments'); check(await attachments.getByRole('button',{name:'Add attachment',exact:true}).count()===1,'attachment add action is missing'); check(await attachments.getByLabel('Attachment file',{exact:true}).count()===1,'attachment picker is missing'); await attachments.getByRole('button',{name:'Add attachment',exact:true}).click(); await attachments.getByLabel('Attachment file',{exact:true}).evaluate(input => input.dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true}))); check(await itemLayout.isVisible(),'canceling the attachment picker closed the card'); await attachments.getByLabel('Attachment file',{exact:true}).setInputFiles({name:'plan.txt',mimeType:'text/plain',buffer:Buffer.from('attachment body')}); await page.getByRole('status').filter({hasText:'Attachment uploaded.'}).waitFor(); check(await attachments.getByRole('link',{name:'plan.txt',exact:true}).count()===1,'uploaded attachment is not listed'); const fileMark = attachments.locator('.attachment-file-mark').filter({hasText:'TXT'}).first(); check(await fileMark.count()===1,'uploaded attachment file type is missing'); check(await fileMark.evaluate(mark => getComputedStyle(mark).whiteSpace === 'nowrap' && !mark.hasAttribute('title') && !mark.parentElement?.hasAttribute('title')),'attachment file type wraps or retains a duplicate native tooltip'); await fileMark.hover(); const attachmentTooltip = page.locator('#attachment-tooltip'); await attachmentTooltip.waitFor({state:'visible'}); check(await attachmentTooltip.textContent() === 'TXT file · text/plain','attachment hover description is missing'); check(await attachmentTooltip.evaluate(tooltip => { const box = tooltip.getBoundingClientRect(); const attachment = tooltip.closest('dialog')?.querySelector('.attachment-tile-link'); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && (!attachment || box.top >= attachment.getBoundingClientRect().bottom - 1) && tooltip.parentElement?.matches('dialog[open]'); }),'attachment hover description is clipped, above the attachment, or outside the editor layer'); await attachments.evaluate(section => { const data = new DataTransfer(); data.items.add(new File(['dropped attachment'], 'dropped.txt', {type:'text/plain'})); section.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data})); if (!section.classList.contains('attachment-drop-active')) throw new Error('attachment drop target did not activate'); section.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); }); await page.getByRole('status').filter({hasText:'Attachment uploaded.'}).waitFor(); check(await attachments.getByRole('link',{name:'dropped.txt',exact:true}).count()===1,'dropped attachment is not listed'); const attachmentActions = attachments.locator('.attachment-actions').first(); await attachmentActions.locator('summary').click(); check(await attachmentActions.locator('[role="menuitem"]',{hasText:'Remove attachment'}).isVisible(),'remove attachment menu did not open'); await itemLayout.getByLabel('Title',{exact:true}).click(); check(await attachmentActions.locator('[role="menuitem"]',{hasText:'Remove attachment'}).isHidden(),'remove attachment menu stayed open after clicking elsewhere');
 const linksField = itemLayout.locator('.multi-select-field').filter({hasText:'GitLab links'}); const gitLabURL = linksField.getByLabel('GitLab MR URL',{exact:true}); check(await gitLabURL.count()===1,'GitLab paste control is not below the links picker'); check(await gitLabURL.getAttribute('placeholder')==='Paste GitLab MR URL, then press Enter or click Get','GitLab paste usage is not described by the placeholder'); check(await linksField.getByRole('button',{name:'Get',exact:true}).count()===1,'GitLab paste Get control is missing'); const addLink = itemLayout.getByRole('button',{name:'Add link',exact:true}); check(await addLink.count()===1,'Add link action is missing'); check(await addLink.evaluate(button => !button.classList.contains('primary')),'Add link should use the secondary button style'); check(await itemLayout.getByRole('button',{name:/^＋ Add GitLab link$/}).count()===0,'old Add GitLab link action is still present'); check(await itemLayout.locator('.item-editor-controls .help').filter({hasText:'Item revision'}).count()===0,'item revision still consumes control-pane space');
 const itemInfo = page.getByRole('button',{name:'Help: Work item details',exact:true}); check(await itemInfo.count()===1,'work-item details popover is missing'); await itemInfo.click(); const itemTooltip = page.getByRole('tooltip').filter({hasText:'Card ID'}); await itemTooltip.waitFor(); const itemTooltipText = await itemTooltip.textContent(); check(itemTooltipText.includes('Card ID:') && itemTooltipText.includes('Revision:') && itemTooltipText.includes('\n') && itemTooltipText.indexOf('Card ID:') < itemTooltipText.indexOf('Revision:'),'card ID and revision are not ordered on separate lines'); check(await itemTooltip.evaluate(tooltip => { const form=tooltip.closest('form').getBoundingClientRect(); return tooltip.getBoundingClientRect().right <= form.right + 1 && getComputedStyle(tooltip).boxShadow !== 'none'; }),'work-item popover is unreadable or overflows the card');
 const layoutColumns = await itemLayout.evaluate(layout => { const primary = layout.querySelector('.item-editor-primary').getBoundingClientRect(); const controls = layout.querySelector('.item-editor-controls').getBoundingClientRect(); const description = layout.querySelector('.item-editor-primary .markdown-field').getBoundingClientRect(); const comments = layout.querySelector('.item-comments').getBoundingClientRect(); return {primary, controls, descriptionBottom:description.bottom, comments}; });
 const viewportWidth = page.viewportSize()?.width ?? 1280;
 check(viewportWidth < 1000 || (layoutColumns.primary.left < layoutColumns.controls.left && Math.abs(layoutColumns.comments.left - layoutColumns.primary.left) < 1 && layoutColumns.comments.top >= layoutColumns.descriptionBottom),'wide item editor does not place comments below the description');
 check(viewportWidth >= 1000 || (layoutColumns.descriptionBottom <= layoutColumns.controls.top && layoutColumns.controls.bottom <= layoutColumns.comments.top),'stacked item editor does not place controls between description and comments');
 await page.getByRole('button',{name:'Help: Open sprints',exact:true}).click();
 const sprintTooltip = page.getByRole('tooltip').filter({hasText:'Select no open sprint'}); await sprintTooltip.waitFor(); check(await sprintTooltip.evaluate(tooltip => { const form=tooltip.closest('form').getBoundingClientRect(); return tooltip.getBoundingClientRect().right <= form.right + 1; }),'field help popover overflows the card');
 await page.getByRole('dialog').click({position:{x:10,y:10},force:true}); await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:title,exact:true}).click();
 await page.getByRole('combobox',{name:'Move to',exact:true}).selectOption({label:'In progress'}); await save();
 await page.reload(); await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all'); await page.getByRole('button',{name:title,exact:true}).waitFor();
 await page.getByRole('button',{name:title,exact:true}).click();
 check(await page.getByRole('combobox',{name:'Move to',exact:true}).locator('option:checked').textContent()==='In progress','move did not persist');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:"Define the team's acceptance criteria",exact:true}).click();
 await page.getByRole('combobox',{name:'Move to',exact:true}).selectOption({label:'In progress'});
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'WIP limit'}).waitFor();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // A single card can belong to both sprints without duplication.
 await nav('Kanban board'); await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('backlog'); await page.getByRole('button',{name:title,exact:true}).click();
 await chooseMulti('Project', ['Project', 'Cross-project stream']);
 await chooseMulti('Open sprints', ['Sprint 1 · Planning foundations (active)', 'Sprint 2 · Delivery signals (planned)']);
 check(await page.getByLabel('Decision note (optional)',{exact:true}).count()===0,'decision note field is still displayed');
 const comment = page.getByLabel('Add a comment',{exact:true}); const commentEditor = comment.locator('..'); check(await comment.isVisible(),'comment composer does not open in Write'); check(await commentEditor.locator('.markdown-preview').isHidden(),'comment composer unexpectedly opens in Preview'); check(await commentEditor.locator('.markdown-toolbar button').first().getAttribute('aria-label')==='Preview comment','comment editor does not start with Preview'); check(await commentEditor.locator('.markdown-toolbar button').first().textContent()==='Preview','comment mode should show the Preview text'); await comment.fill('Work spans **both sprints**.');
 await page.getByRole('button',{name:'Add comment',exact:true}).click();
 await page.locator('.item-comments .comment').filter({hasText:'Work spans both sprints'}).waitFor();
 check(await page.locator('.item-comments .comment-body strong').textContent()==='both sprints','comment Markdown was not rendered');
 check(await page.locator('.item-comments .comment').count()===1,'item comment was not appended');
 check(await page.locator('.item-comments .comment-head strong').textContent()==='Local fixture user','comment author is missing');
 check(await page.locator('.item-comments .comment-avatar').count()===1,'comment avatar is missing');
 check(await page.locator('.item-comments .comment time').count()===1,'comment creation time is missing');
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 check(await page.getByRole('button',{name:title,exact:true}).count()===0,'scheduled item remained in backlog');
 await nav('Kanban board');
 await page.getByRole('combobox',{name:'Scope',exact:true}).selectOption('all');
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption({label:'Cross-project stream'});
 check(await page.getByRole('button',{name:title,exact:true}).count()===1,'project filtering duplicates or hides card'); check(await page.locator('.card .card-project').filter({hasText:/^Project$/}).count()===1 && await page.locator('.card .card-project').filter({hasText:/^Cross-project stream$/}).count()===1,'multiple project badges are missing'); const cardAttachments = page.locator('.card-attachments'); check(await cardAttachments.count()===1 && await cardAttachments.evaluate(details => details.tagName === 'DETAILS' && !details.open),'card attachments should be collapsed by default'); check(await cardAttachments.evaluate(details => details.parentElement?.lastElementChild === details),'attachments should be at the bottom of the card'); check(await cardAttachments.evaluate(details => getComputedStyle(details).borderTopStyle !== 'none'),'attachments should have a divider'); const attachmentToggle = cardAttachments.locator('.card-attachments-toggle'); const collapsedToggle = await attachmentToggle.evaluate(toggle => { const box=toggle.getBoundingClientRect(); const parent=toggle.parentElement.getBoundingClientRect(); return {width:box.width,height:box.height,centered:Math.abs((box.top+box.height/2)-(parent.top+parent.height/2))<1}; }); check(collapsedToggle.centered,'closed attachment cue is not vertically centered'); await cardAttachments.locator('summary').click(); check(await cardAttachments.locator('.card-attachment-list').evaluate(list => getComputedStyle(list).display === 'grid'),'card attachments should open as a vertical list'); const expandedToggle = await attachmentToggle.evaluate(toggle => { const box=toggle.getBoundingClientRect(); const parent=toggle.parentElement.getBoundingClientRect(); return {width:box.width,height:box.height,centered:Math.abs((box.top+box.height/2)-(parent.top+parent.height/2))<1}; }); check(expandedToggle.centered && Math.abs(collapsedToggle.width - expandedToggle.width) < 1 && Math.abs(collapsedToggle.height - expandedToggle.height) < 1,'attachment open/close cue changes size or position'); await page.getByRole('link',{name:'plan.txt',exact:true}).waitFor(); check(await page.getByRole('link',{name:'plan.txt',exact:true}).count()===1,'attachment is not shown on the card');
 await page.getByText('1 shown · 3/3 WIP',{exact:true}).waitFor();
 await page.getByRole('button',{name:'List',exact:true}).click(); await page.getByRole('heading',{name:'Planning list',exact:true}).waitFor();
 check(await page.locator('.list-row').filter({hasText:title}).count()===1,'an item with multiple sprints appears more than once in List'); await page.setViewportSize({width:390,height:1000}); check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'responsive List overflows horizontally'); check(await page.locator('.list-row').filter({hasText:title}).locator('.list-cell-label').first().isVisible(),'responsive List rows do not expose labeled stacked fields'); await page.setViewportSize({width:1280,height:1000}); await page.getByRole('button',{name:'Board',exact:true}).click();
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('all');
 await page.getByRole('button',{name:title,exact:true}).click();
 check(await page.getByRole('group',{name:'Open sprints',exact:true}).locator('.multi-select-chip').count()===2,'multi-sprint membership not persisted');
 await page.locator('.item-comments .comment').filter({hasText:'Work spans both sprints'}).waitFor();
 await page.getByLabel('Title',{exact:true}).fill('Retained stale draft');
 const other=await page.context().newPage(); other.setDefaultTimeout(10000); await other.goto(page.url());
 await other.getByRole('button',{name:title,exact:true}).click();
 await other.getByLabel('Title',{exact:true}).fill('Concurrent accepted edit');
 await other.getByRole('button',{name:'Save changes',exact:true}).click();
 await other.getByRole('status').filter({hasText:'Changes saved.'}).waitFor(); await other.close();
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'planning changed'}).waitFor();
 check(await page.getByLabel('Title',{exact:true}).inputValue()==='Retained stale draft','draft lost');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 const explicitCard=page.locator(`[data-item="${item.id}"]`);await explicitCard.waitFor();const scopeBefore=await page.getByRole('combobox',{name:'Scope',exact:true}).inputValue();const projectBefore=await page.getByRole('combobox',{name:'Project',exact:true}).inputValue();await explicitCard.evaluate(node=>{window.__fluxManualCard=node;});
 const injectedBoard=await page.evaluate(async()=>{const workspace=document.querySelector('#workspace').value;return (await fetch(`/api/v2/workspaces/${encodeURIComponent(workspace)}/board`)).json();});injectedBoard.workspace.revision++;let injectPlanningRevision=true;await page.route('**/board',async route=>{if(!injectPlanningRevision){await route.continue();return;}injectPlanningRevision=false;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(injectedBoard)});});await page.waitForTimeout(16000);await page.unroute('**/board');await page.getByText('Planning changed elsewhere · Refresh to review',{exact:true}).waitFor();check(await explicitCard.evaluate(node=>node===window.__fluxManualCard),'planning notice replaced the current board');
 await page.locator('#planning-refresh').click();
 await page.getByRole('button',{name:'Concurrent accepted edit',exact:true}).waitFor();check(await explicitCard.evaluate(node=>node===window.__fluxManualCard),'keyed manual refresh recreated the item card');check(await page.getByRole('combobox',{name:'Scope',exact:true}).inputValue()===scopeBefore&&await page.getByRole('combobox',{name:'Project',exact:true}).inputValue()===projectBefore,'manual refresh lost planning filters');
 // Concurrent active workspace sprints are allowed; close only the first one.
 await nav('Sprints'); await page.getByRole('heading',{name:'Sprints',exact:true}).waitFor(); const sprintToolbar = page.locator('#planning-filters'); const sprintSearch = sprintToolbar.getByRole('searchbox',{name:'Search',exact:true}); const sprintCount = page.locator('#count'); const sprintSections = page.locator('#content > .maintenance-sections'); check(await sprintSections.evaluate(sections => sections.firstElementChild?.classList.contains('velocity-panel')),'the delivery trend is not the first section on the Sprints page'); check(await sprintSections.evaluate(sections => { const planning = sections.lastElementChild; const children = [...planning.children]; return children[0]?.classList.contains('section-head') && children[1]?.id === 'sprint-filter-slot' && children[1].contains(document.getElementById('planning-filters')); }),'the sprint filter bar is not inside the content below its heading'); check(await sprintToolbar.evaluate(bar => bar.classList.contains('filter-bar')),'the sprint filters do not use the shared filter bar component'); const sprintProjectFilter = sprintToolbar.getByRole('combobox',{name:'Project',exact:true}); const sprintPanels = page.locator('.sprint-panel'); const allSprintNames = await sprintPanels.locator('h2').allTextContents(); await sprintProjectFilter.selectOption('none'); await page.waitForTimeout(200); const unfiledSprintNames = await sprintPanels.locator('h2').allTextContents(); check(unfiledSprintNames.length < allSprintNames.length,'the sprint list is not filtered by the planning filters'); check(await sprintCount.textContent()===`${unfiledSprintNames.length} ${unfiledSprintNames.length === 1 ? 'sprint' : 'sprints'}`,'the sprint count does not follow the filtered list'); await sprintProjectFilter.selectOption('all'); await page.waitForTimeout(200); check((await sprintPanels.locator('h2').allTextContents()).length === allSprintNames.length,'clearing the project filter did not restore the sprint list'); const sprintFilterLabels = await sprintToolbar.locator('.actions > label').evaluateAll(labels => labels.filter(label => !label.hidden && getComputedStyle(label).display !== 'none').map(label => label.textContent.trim())); check(await sprintToolbar.isVisible() && await sprintSearch.count()===1 && sprintFilterLabels.join('|')==='Project|Assignee|Search','sprint filters are not in a horizontal line in the expected order'); await sprintSearch.fill('PLANNING FOUNDATIONS'); await page.locator('.sprint-panel').waitFor(); check(await page.locator('.sprint-panel').count()===1 && await sprintCount.textContent()==='1 sprint','sprint search is not case insensitive or count is wrong'); await sprintSearch.fill('does-not-exist'); await page.getByText('No sprints match “does-not-exist”.',{exact:true}).waitFor(); check(await page.locator('.sprint-panel').count()===0 && await sprintCount.textContent()==='0 sprints','sprint search did not filter empty results'); await sprintSearch.fill(''); await page.getByRole('button',{name:'Start sprint',exact:true}).click(); await saved();
 check(await page.getByText('ACTIVE SPRINT',{exact:true}).count()===2,'concurrent active sprints rejected');
 const first=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Sprint 1 · Planning foundations',exact:true})});
 await first.getByRole('button',{name:'Close sprint',exact:true}).click();
 await page.getByRole('combobox',{name:'Also assign unfinished work to',exact:true}).selectOption('');
 await page.getByLabel('Closing decision / rationale').fill('Close first sprint; retain next sprint assignment');
 await page.getByRole('dialog').getByRole('button',{name:'Close sprint',exact:true}).click(); await saved();
 check(await page.getByText('CLOSED SPRINT',{exact:true}).count()===1,'closed sprint missing');
 check(await page.getByText('ACTIVE SPRINT',{exact:true}).count()===1,'other sprint altered');
 await nav('Kanban board'); const scope = page.getByRole('combobox',{name:'Scope',exact:true}); await scope.selectOption({label:'Sprint 1 · Planning foundations (closed)'});
 await page.getByText('CLOSED SPRINT',{exact:true}).waitFor(); check(await page.getByRole('heading',{name:'Sprint 1 · Planning foundations',exact:true}).count()===1,'closed sprint panel is missing from sprint info');
 const reopenSprint = page.getByRole('button',{name:'Re-open sprint',exact:true}); check(!(await reopenSprint.getAttribute('class') || '').split(/\s+/).includes('primary'),'re-open sprint should use the standard button style'); await reopenSprint.click(); await saved();
 check(await page.getByText('ACTIVE SPRINT',{exact:true}).count()===2,'re-opening did not make the sprint active');
 await scope.selectOption('active'); await page.getByRole('button',{name:'Concurrent accepted edit',exact:true}).click();
 await page.getByText('Closed sprint history (read-only): Sprint 1 · Planning foundations',{exact:true}).waitFor();
 check(await page.getByRole('group',{name:'Open sprints',exact:true}).locator('.multi-select-chip').count()===2,'re-opening did not restore the closed sprint membership');

 // Clearing project classification does not change sprint membership or history.
 await chooseMulti('Project', ['No project']);
 await page.getByRole('button',{name:'Save changes',exact:true}).click(); await saved();
 await page.getByRole('combobox',{name:'Project',exact:true}).selectOption('none');
 await page.getByRole('button',{name:'Concurrent accepted edit',exact:true}).click();
 await page.getByRole('button',{name:'Archive item',exact:true}).click();
 await page.getByRole('heading',{name:'Archive work item',exact:true}).waitFor();
 await page.getByRole('button',{name:'Archive item',exact:true}).click(); await saved();
 await nav('Archive'); await page.getByRole('heading',{name:'Archive',exact:true}).waitFor(); await page.getByRole('button',{name:'Restore item',exact:true}).click(); await saved();

 // A card is reordered locally before the write is acknowledged, so a rejected
 // write must restore the exact previous placement rather than leave the
 // optimistic result showing state the server never accepted.
 await nav('Kanban board'); await page.getByRole('heading',{name:'Kanban board',exact:true}).waitFor();
 const placement = async () => page.locator('.column').first().locator('.card .card-title').allTextContents();
 const beforeDrop = await placement();
 check(beforeDrop.length>1,'need at least two cards in the first column to test rollback');
 let rejectedMoves = 0;
 await page.route('**/changes',route => { rejectedMoves++; return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'planning changed; refresh and review before saving'})}); });
 const [source,target] = await page.locator('.column').first().locator('.card').all();
 await source.dragTo(target);
 // A drag that produced no command cannot exercise the rollback; fail loudly
 // rather than silently passing on an unchanged board.
 await page.waitForFunction(() => !document.querySelector('#notice')?.textContent.includes('Saving'),null,{timeout:15000});
 check(rejectedMoves>0,'dragging a card onto its neighbour issued no planning change');
 await page.getByRole('alert').filter({hasText:'planning changed'}).waitFor();
 check(JSON.stringify(await placement())===JSON.stringify(beforeDrop),'a rejected move was not rolled back to its previous placement');
 await page.unroute('**/changes');

 // A batch must settle with one board read: every command but the last asks
 // for a minimal receipt, so the server is not asked for a board it discards.
 const preferences = [];
 await page.route('**/changes',route => { preferences.push(route.request().headers()['prefer'] || ''); return route.continue(); });
 await page.unroute('**/changes');
 if (preferences.length > 1) {
  check(preferences.slice(0,-1).every(value => value==='return=minimal'),`batch commands must request a minimal receipt: ${JSON.stringify(preferences)}`);
  check(preferences.at(-1)==='','the final batch command must take the committed board');
 }

 await nav('History'); await page.getByRole('heading',{name:'History',exact:true}).waitFor(); await page.getByText('item · restore',{exact:true}).waitFor(); const historyText = await page.locator('.history-row').first().textContent(); const historyActor = historyText.split(' · ')[0]; check(/\S+ \([^)]+\)$/.test(historyActor),'history rows should show known actors as name (subject)'); const workspaceLabel = await page.locator('#workspace option:checked').textContent(); const workspaceID = await page.locator('#workspace').inputValue(); check(historyText.includes(workspaceLabel) && historyText.includes(workspaceID),'history rows should identify the workspace by name and ID');
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
   const newItemDialog = page.getByRole('dialog'); const checkContainedFocus = async (field, name) => { await field.focus(); check(await field.evaluate(element => { const fields = element.closest('#fields').getBoundingClientRect(); const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return style.outlineStyle === 'none' && style.boxShadow !== 'none' && box.left >= fields.left - 1 && box.top >= fields.top - 1 && box.right <= fields.right + 1 && box.bottom <= fields.bottom + 1; }), `${name} focus ring overflows its scroll frame`); }; await checkContainedFocus(newItemDialog.getByLabel('Title',{exact:true}), 'Title'); await checkContainedFocus(newItemDialog.getByRole('combobox',{name:'Move to',exact:true}), 'Move to');
   await page.keyboard.press('Escape');check(await page.getByRole('button',{name:'＋ New item',exact:true}).evaluate(e=>e===document.activeElement),'focus return');
  }
 }
 return 'PASS: workspace board, multi-project associations and project name/assignee/label filtering, sprint search, shared WIP, immutable item comments, card attachments, GitLab link controls, multi-sprint persistence, concurrent active sprints, closure isolation/history, stale edits, archive/restore, six accessible responsive layouts, optimistic move rollback and single-board-read batches.';
}
