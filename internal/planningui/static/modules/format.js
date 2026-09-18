// Presentation formatting. Pure functions from planning values to display
// strings; none of them read application state or touch the DOM.
function initials(name) { const words = name.trim().split(/\s+/).filter(Boolean); return words.length ? words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase() : '—'; }
function attachmentSize(size) {
 if (!Number.isFinite(size) || size < 0) return 'unknown size';
 if (size < 1024) return `${size} B`;
 const units = ['KiB', 'MiB', 'GiB']; let value = size; let index = -1;
 while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
 return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
function attachmentKind(attachment) {
 const type = String(attachment.content_type || '');
 if (type.startsWith('image/')) return 'IMG';
 if (type.startsWith('video/')) return 'VID';
 if (type.startsWith('audio/')) return 'AUD';
 if (type === 'application/pdf') return 'PDF';
 if (type.includes('zip') || type.includes('tar') || type.includes('gzip')) return 'ZIP';
 const extension = String(attachment.name || '').split('.').at(-1)?.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase();
 return extension || 'FILE';
}
function attachmentTypeDescription(attachment) {
 const type = String(attachment.content_type || '').trim(); return type ? `${attachmentKind(attachment)} file · ${type}` : `${attachmentKind(attachment)} file`;
}
function labelForeground(color) {
 const match = /^#([0-9a-f]{6})$/i.exec(color || ''); if (!match) return 'var(--ink)';
 const value = Number.parseInt(match[1], 16); const channels = [value >> 16 & 255, value >> 8 & 255, value & 255].map(channel => { channel /= 255; return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
 const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
 return luminance > .21 ? 'var(--label-ink)' : 'var(--label-contrast)';
}
function burndownDateLabel(date) { const value = new Date(`${date}T00:00:00Z`); return Number.isNaN(value.getTime()) ? date : value.toLocaleDateString(undefined, {month:'short', day:'numeric', timeZone:'UTC'}); }
function workspaceLabel(workspace) { return workspace.name; }
function workspaceHistoryLabel(workspace) { return `${workspace.name} (${workspace.id})`; }
function columnWIPLabel(column, total) { return column.wip ? `${total}/${column.wip} WIP` : 'No limit'; }

export {initials, attachmentSize, attachmentKind, attachmentTypeDescription, labelForeground, burndownDateLabel, workspaceLabel, workspaceHistoryLabel, columnWIPLabel};
