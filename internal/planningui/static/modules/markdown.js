// Markdown rendering and the Markdown editor control. Rendering builds DOM
// nodes directly and never assigns innerHTML, so item and comment bodies
// cannot inject markup. Link targets are filtered through markdownURL.
import {el, button, uid, noAutofill} from './dom.js';
import {requestKey} from './api.js';

function markdownURL(value) {
 const raw = String(value || '').trim(); if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
 try { const url = new URL(raw, location.href); if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return ''; return url.href; } catch { return ''; }
}
function markdownEscaped(value) { return value === String.fromCharCode(92) || '`*_[]~'.includes(value); }
function appendMarkdownInline(parent, source) {
 let i = 0;
 while (i < source.length) {
  if (source[i] === String.fromCharCode(92) && i + 1 < source.length && markdownEscaped(source[i + 1])) { parent.append(document.createTextNode(source[i + 1])); i += 2; continue; }
  if (source[i] === '`') {
   const match = /^`+/.exec(source.slice(i)); const marker = match?.[0]; const end = marker ? source.indexOf(marker, i + marker.length) : -1;
   if (marker && end > i + marker.length) { parent.append(el('code', source.slice(i + marker.length, end), 'markdown-inline-code')); i = end + marker.length; continue; }
  }
  if (source.startsWith('![', i)) { parent.append(document.createTextNode('![')); i += 2; continue; }
  const link = /^([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"\n]*["'])?\)/.exec(source.slice(i).startsWith('[') ? source.slice(i).slice(1) : '');
  if (source[i] === '[' && link) {
   const whole = '[' + link[0]; const href = markdownURL(link[2]);
   if (href) { const anchor = el('a'); anchor.href = href; if (new URL(href, location.href).origin !== location.origin) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } appendMarkdownInline(anchor, link[1]); parent.append(anchor); } else parent.append(document.createTextNode(whole));
   i += whole.length; continue;
  }
  const auto = /^<((?:https?|mailto):[^<>\s]+)>/.exec(source.slice(i));
  if (auto) {
   const href = markdownURL(auto[1]); if (href) { const anchor = el('a', auto[1]); anchor.href = href; if (new URL(href, location.href).origin !== location.origin) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } parent.append(anchor); } else parent.append(document.createTextNode(auto[0]));
   i += auto[0].length; continue;
  }
  let formatted = false;
  for (const [marker, tag] of [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']]) {
   if (!source.startsWith(marker, i)) continue;
   if ((marker === '*' || marker === '_') && /\w/.test(source[i - 1] || '') && /\w/.test(source[i + marker.length] || '')) continue;
   const end = source.indexOf(marker, i + marker.length); if (end <= i + marker.length) continue;
   const node = el(tag); appendMarkdownInline(node, source.slice(i + marker.length, end)); parent.append(node); i = end + marker.length; formatted = true; break;
  }
  if (formatted) continue;
  parent.append(document.createTextNode(source[i])); i++;
 }
}
function markdownBlockStart(line) { return /^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line); }
function markdownTableCells(line) {
 const value = line.trim(); if (!value.includes('|')) return null; const withoutStart = value.startsWith('|') ? value.slice(1) : value; const source = withoutStart.endsWith('|') ? withoutStart.slice(0, -1) : withoutStart; const cells = []; let cell = ''; let escaped = false;
 for (const character of source) { if (character === '|' && !escaped) { cells.push(cell.trim()); cell = ''; } else cell += character; escaped = character === '\\' && !escaped; if (character !== '\\') escaped = false; }
 cells.push(cell.trim()); return cells;
}
function renderMarkdown(parent, source) {
 parent.replaceChildren(); const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n'); let index = 0;
 while (index < lines.length) {
  if (!lines[index].trim()) { index++; continue; }
  const tableHeader = markdownTableCells(lines[index]); const tableRule = index + 1 < lines.length ? markdownTableCells(lines[index + 1]) : null;
  if (tableHeader?.length && tableRule?.length === tableHeader.length && tableRule.every(cell => /^:?-{3,}:?$/.test(cell))) {
   const table = el('table', undefined, 'markdown-table'); const alignments = tableRule.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.startsWith(':') ? 'left' : cell.endsWith(':') ? 'right' : '');
   const row = (tag, cells) => { const result = el('tr'); cells.forEach((cell, cellIndex) => { const node = el(tag); if (alignments[cellIndex]) node.style.textAlign = alignments[cellIndex]; appendMarkdownInline(node, cell); result.append(node); }); return result; };
   const head = el('thead'); head.append(row('th', tableHeader)); const body = el('tbody'); index += 2;
   while (index < lines.length && lines[index].trim()) { const cells = markdownTableCells(lines[index]); if (!cells || cells.length !== tableHeader.length) break; body.append(row('td', cells)); index++; }
   table.append(head, body); parent.append(table); continue;
  }
  const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(lines[index]);
  if (fence) {
   const marker = fence[1]; const code = []; index++;
   while (index < lines.length) { const trimmed = lines[index].trim(); if (trimmed.length >= marker.length && [...trimmed].every(character => character === marker[0])) { index++; break; } code.push(lines[index++]); }
   const pre = el('pre', undefined, 'markdown-code-block'); pre.append(el('code', code.join('\n'))); parent.append(pre); continue;
  }
  const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(lines[index]);
  if (heading) { const node = el('h' + heading[1].length); appendMarkdownInline(node, heading[2]); parent.append(node); index++; continue; }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) { parent.append(el('hr', undefined, 'markdown-rule')); index++; continue; }
  const quote = /^\s{0,3}>\s?(.*)$/.exec(lines[index]);
  if (quote) {
   const quoteLines = [];
   while (index < lines.length) { const line = /^\s{0,3}>\s?(.*)$/.exec(lines[index]); if (!line) break; quoteLines.push(line[1]); index++; }
   const blockquote = el('blockquote'); renderMarkdown(blockquote, quoteLines.join('\n')); parent.append(blockquote); continue;
  }
  const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(lines[index]); const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(lines[index]);
  if (unordered || ordered) {
   const list = el(ordered ? 'ol' : 'ul'); const pattern = ordered ? /^\s{0,3}\d+[.)]\s+(.+)$/ : /^\s{0,3}[-+*]\s+(.+)$/;
   while (index < lines.length) { const item = pattern.exec(lines[index]); if (!item) break; const listItem = el('li'); const task = /^\[([ xX])\]\s+(.+)$/.exec(item[1]); if (task) { const checkbox = el('input'); checkbox.id = uid('markdown-task'); checkbox.type = 'checkbox'; checkbox.checked = task[1].toLowerCase() === 'x'; checkbox.disabled = true; checkbox.tabIndex = -1; checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task'); listItem.className = 'markdown-task'; listItem.append(checkbox); appendMarkdownInline(listItem, task[2]); } else appendMarkdownInline(listItem, item[1]); list.append(listItem); index++; }
   parent.append(list); continue;
  }
  const paragraphLines = [lines[index++]];
  while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index])) paragraphLines.push(lines[index++]);
  const paragraph = el('p'); paragraphLines.forEach((line, lineIndex) => { if (lineIndex) paragraph.append(el('br')); appendMarkdownInline(paragraph, line); }); parent.append(paragraph);
 }
}
function markdownEditor(parent, name, title, value = '', maxLength = 4000, readOnly = false, previewByDefault = false) {
 const group = el('div', undefined, 'markdown-field'); const inputID = 'markdown-' + requestKey(); const label = el('label', undefined, 'markdown-label'); label.htmlFor = inputID; label.append(el('span', title)); group.append(label);
 if (readOnly) { const preview = el('div', undefined, 'markdown-preview'); renderMarkdown(preview, value); if (!String(value || '').trim()) preview.append(el('p', 'No content.', 'help')); group.append(preview); parent.append(group); return {input: null, refresh: () => {}}; }
 const editor = el('div', undefined, 'markdown-editor'); const toolbar = el('div', undefined, 'markdown-toolbar'); const subject = title === 'Description' ? 'description' : 'comment'; let previewing = previewByDefault;
 const modeButton = button(previewByDefault ? 'Edit' : 'Preview', () => setMode(!previewing), 'markdown-mode'); modeButton.setAttribute('aria-label', `Preview ${subject}`); modeButton.title = `Preview ${subject}`; toolbar.append(modeButton);
 const input = noAutofill(el('textarea')); input.id = inputID; input.name = name; input.value = value || ''; input.maxLength = maxLength; input.placeholder = 'Write Markdown…'; input.spellcheck = true; input.dataset.markdownControl = 'true'; const preview = el('div', undefined, 'markdown-preview'); preview.hidden = true; preview.tabIndex = 0;
 function replaceSelection(transform, placeholder = 'text') { const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; const selected = input.value.slice(start, end) || placeholder; input.setRangeText(transform(selected), start, end, 'select'); input.dispatchEvent(new Event('input', {bubbles: true})); input.focus(); }
 const tools = [], dividers = []; function addDivider() { const divider = el('span', undefined, 'markdown-divider'); divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', 'vertical'); divider.setAttribute('aria-hidden', 'true'); dividers.push(divider); toolbar.append(divider); }
 function addTool(label, icon, transform, placeholder) { const tool = button(icon, () => replaceSelection(transform, placeholder), 'markdown-tool'); tool.setAttribute('aria-label', label); tool.title = label; tools.push(tool); toolbar.append(tool); }
 const prefixLines = (text, prefix) => text.split('\n').map(line => prefix + line).join('\n');
 addDivider(); addTool('Bold', 'B', text => `**${text}**`, 'bold text'); addTool('Italic', 'I', text => `_${text}_`, 'italic text'); addTool('Strikethrough', 'S', text => `~~${text}~~`, 'struck text');
 addDivider(); addTool('Inline code', '<>', text => '`' + text + '`', 'code'); addTool('Code block', '▣', text => '```\n' + text + '\n```', 'code block'); addTool('Link', '↗', text => `[${text}](https://example.com)`, 'link text');
 addDivider(); addTool('Heading', 'H', text => prefixLines(text, '## '), 'heading'); addTool('Insert table', '▦', text => '\n\n| ' + text + ' | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n', 'Header 1');
 addDivider(); addTool('Bulleted list', '•', text => prefixLines(text, '- '), 'list item'); addTool('Numbered list', '1.', text => text.split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n'), 'list item'); addTool('Task list', '☑', text => prefixLines(text, '- [ ] '), 'task item');
 addDivider(); addTool('Quote', '❝', text => prefixLines(text, '> '), 'quoted text'); addTool('Horizontal rule', '—', () => '---', '');
 function renderPreview() { renderMarkdown(preview, input.value); if (!input.value.trim()) preview.append(el('p', 'Nothing to preview yet.', 'help')); }
 function updateModeButton() { const label = previewing ? `Edit ${subject}` : `Preview ${subject}`; modeButton.textContent = previewing ? 'Edit' : 'Preview'; modeButton.setAttribute('aria-label', label); modeButton.title = label; }
 function setMode(next) { previewing = next; updateModeButton(); tools.concat(dividers).forEach(control => { control.hidden = next; }); input.hidden = next; preview.hidden = !next; if (next) renderPreview(); else input.focus(); }
 const refresh = () => { if (previewing) renderPreview(); }; input.addEventListener('input', refresh); input.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return; const key = event.key.toLowerCase();
  if (key === 'b') { event.preventDefault(); replaceSelection(text => `**${text}**`, 'bold text'); }
  else if (key === 'i') { event.preventDefault(); replaceSelection(text => `_${text}_`, 'italic text'); }
  else if (key === 'k') { event.preventDefault(); replaceSelection(text => `[${text}](https://example.com)`, 'link text'); }
  else if (event.shiftKey && key === 'x') { event.preventDefault(); replaceSelection(text => `~~${text}~~`, 'struck text'); }
 }); editor.append(toolbar, input, preview); group.append(editor); parent.append(group); if (previewByDefault) setMode(true); else updateModeButton(); return {input, refresh};
}

export {renderMarkdown, markdownEditor};
