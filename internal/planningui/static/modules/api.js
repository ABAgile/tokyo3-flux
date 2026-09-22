// Planning HTTP transport. Callers supply CSRF and Idempotency-Key headers;
// this module only normalizes responses and error messages.
// Expired browser API requests are redirected to OAuth by the session gate.
// Stop that redirect here: OAuth must be a top-level navigation, not a
// cross-origin fetch that the page CSP correctly blocks.
let sessionRedirecting = false;
function sessionExpiredError() {
 if (!sessionRedirecting) {
  sessionRedirecting = true;
  const returnTo = location.pathname + location.search;
  location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo || '/')}`);
 }
 return new Error('Session expired. Redirecting to sign in.');
}
function sessionExpired() { throw sessionExpiredError(); }
function isRedirectResponse(response) { return response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304); }
async function api(path, init = {}) {
 const r = await fetch(path, { ...init, redirect: 'manual', headers: { 'Accept': 'application/json', ...init.headers } });
 if (isRedirectResponse(r) || r.status === 401) sessionExpired();
 if (r.status === 204) return null;
 let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); }
 if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
 return data;
}
// Conditional read. Planning responses are no-store, so the browser never
// revalidates on its own; the caller keeps the last ETag and passes it back,
// and an unchanged resource answers with an empty 304.
async function apiRevalidated(path, etag = '') {
 const headers = {'Accept': 'application/json'}; if (etag) headers['If-None-Match'] = etag;
 const r = await fetch(path, {redirect: 'manual', headers});
 if (isRedirectResponse(r) || r.status === 401) sessionExpired();
 if (r.status === 304) return {modified: false, etag: r.headers.get('ETag') || etag, data: undefined};
 let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); }
 if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
 return {modified: true, etag: r.headers.get('ETag') || '', data};
}
// Multipart upload with progress. `fetch` cannot report request progress, so
// attachment uploads use XMLHttpRequest and report bytes sent to the caller.
// Response and error normalization matches `api` so call sites are identical.
function apiUpload(path, {headers = {}, body, onProgress} = {}) {
 return new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('POST', path);
  request.responseType = 'text';
  request.setRequestHeader('Accept', 'application/json');
  Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
  if (onProgress) request.upload.addEventListener('progress', event => { onProgress(event.lengthComputable ? Math.min(1, event.loaded / event.total) : undefined); });
  request.addEventListener('error', () => reject(new Error('Planning service unavailable. Refresh to retry.')));
  request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
  request.addEventListener('timeout', () => reject(new Error('Upload timed out. Refresh to retry.')));
  request.addEventListener('load', () => {
   // XHR follows redirects transparently, so a login redirect surfaces as a
   // final URL on a different path rather than as a redirect status.
   let responsePath = path; try { responsePath = new URL(request.responseURL || path, location.href).pathname; } catch {}
   if (responsePath !== new URL(path, location.href).pathname) { reject(sessionExpiredError()); return; }
   if (request.status === 401) { reject(sessionExpiredError()); return; }
   if (request.status === 204) { resolve(null); return; }
   let data; try { data = JSON.parse(request.responseText); } catch { reject(new Error('Planning service unavailable. Refresh to retry.')); return; }
   if (request.status < 200 || request.status >= 300) { reject(new Error(data.error || `Request failed (${request.status})`)); return; }
   resolve(data);
  });
  request.send(body);
 });
}
function requestKey() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }

export {api, apiRevalidated, apiUpload, requestKey};
