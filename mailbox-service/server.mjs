import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Store, hash, id, token, now, fail } from './store.mjs';
import { createMailboxMcp } from './mcp.mjs';
import { startDelivery } from './webhook.mjs';
import { page, login, dashboard, consent, taskPage } from './pages.mjs';
import { WorkerSetup, setupCode, validSetupCode } from './worker-setup.mjs';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req, max = 24000) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > max) fail('request_too_large', 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function form(raw) {
  const result = new URLSearchParams(raw);
  for (const key of new Set(result.keys())) if (result.getAll(key).length !== 1) fail('duplicate_parameter');
  return result;
}
export async function start(options = {}) {
  const origin = options.origin || process.env.DOT_ORIGIN;
  const parsed = new URL(origin), local = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.origin !== origin || (!local && parsed.protocol !== 'https:')) throw new Error('DOT_ORIGIN must be an HTTPS origin.');
  const redirects = options.redirects || (process.env.DOT_REDIRECTS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!redirects.length) throw new Error('DOT_REDIRECTS must contain exact approved OAuth callback URLs.');
  for (const redirect of redirects) { const url = new URL(redirect); if (url.hash || url.username || url.password || (url.protocol !== 'https:' && !(local && url.hostname === '127.0.0.1'))) throw new Error('Invalid redirect allowlist.'); }
  const store = options.store || new Store(options.root || process.env.DOT_DATA, options.secret || process.env.DOT_SECRET);
  store.origin = origin;
  const workerSetup = new WorkerSetup(store);
  const mcp = createMailboxMcp(store, options);
  const delivery = options.delivery === false ? null : startDelivery(store, options.webhookPost);
  const resource = origin + '/mcp';
  let inflight = 0, stopping = false;
  const cookieOptions = `HttpOnly; SameSite=Lax; Path=/${local ? '' : '; Secure'}`;
  const cookieName = name => (local ? '' : '__Host-') + name;
  const maintenance = setInterval(() => { try { store.cleanup(); workerSetup.cleanup(); } catch { console.error('Maintenance error'); } }, 60000); maintenance.unref();
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    // Native HTML form posts need their same-origin Origin header for CSRF checks.
    // Keep referrers suppressed for other origins and for API responses.
    const html = value => { res.setHeader('Referrer-Policy', 'same-origin'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(value); };
    const redirect = url => { res.writeHead(303, { Location: url }); res.end(); };
    const allowOAuthRedirect = url => {
      // Only the validated, exact OAuth callback may follow a consent form post.
      res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy')).replace("form-action 'self';", `form-action 'self' ${url};`));
    };
    const cookie = name => new RegExp('(?:^|;\\s*)' + cookieName(name) + '=([A-Za-z0-9_-]+)').exec(req.headers.cookie || '')?.[1];
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (!local) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let counted = false;
    try {
      // Local health checks reach the loopback port without the public Host header.
      if (req.url === '/health' && req.method === 'GET') return json(200, { status: 'ok', service: 'dot-mailbox' });
      if (req.headers.host !== parsed.host) return json(400, { error: 'invalid_host' });
      if (stopping || inflight >= 24) return json(503, { error: 'temporarily_unavailable' });
      inflight++; counted = true;
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'invalid_origin' });
      const url = new URL(req.url, origin), route = url.pathname;
      // Nginx overwrites this with the actual connection address. Never trust client-supplied tenant IDs.
      const remote = options.trustProxy ? String(req.headers['x-real-ip'] || 'unknown') : req.socket.remoteAddress || 'unknown';
      store.rate('http:' + remote.slice(0, 100), 1200);
      if (route === '/.well-known/oauth-protected-resource/mcp' || route === '/.well-known/oauth-protected-resource') return json(200, { resource, authorization_servers: [origin], scopes_supported: ['mailbox'], resource_name: "Ninja Agent Mailbox" });
      if (route === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin, authorization_response_iss_parameter_supported: true, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', revocation_endpoint: origin + '/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mailbox'] });
      if (route === '/register' && req.method === 'POST') {
        // Registration is public. The per-address limit runs first so one source cannot spend the shared budget.
        store.rate('register:' + remote.slice(0, 100), 20, 3600000);
        store.rate('register:global', 300, 3600000);
        const data = JSON.parse(await body(req, 8192));
        if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 || data.redirect_uris.length > 4 || data.redirect_uris.some(value => !redirects.includes(value))) fail('invalid_redirect_uri');
        if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none') fail('invalid_client_metadata');
        if (store.get('SELECT count(*) AS n FROM clients').n >= 3000) fail('client_limit', 503);
        const client = { client_id: token(), client_name: String(data.client_name || 'MCP client').slice(0, 80), redirect_uris: data.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
        store.run('INSERT INTO clients VALUES(?,?,?)', client.client_id, JSON.stringify(client), now() + 30 * 86400000); return json(201, client);
      }
      if (route === '/authorize' && req.method === 'GET') {
        const q = form(url.search.slice(1));
        const clientRow = store.get('SELECT * FROM clients WHERE id=?', q.get('client_id')); if (!clientRow) fail('invalid_client');
        const client = JSON.parse(clientRow.data);
        if (!client.redirect_uris.includes(q.get('redirect_uri'))) fail('invalid_redirect_uri');
        if (q.get('resource') !== resource || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(q.get('code_challenge') || '') || (q.get('scope') || 'mailbox') !== 'mailbox' || (q.get('state') || '').length > 512) fail('invalid_request');
        store.rate('authorize:' + remote, 60);
        if (store.get('SELECT count(*) AS n FROM tickets').n >= 500) fail('busy', 503);
        const ticket = token(), csrf = token();
        store.run('INSERT INTO tickets VALUES(?,?,?,?)', ticket, JSON.stringify({ client: client.client_id, redirect: q.get('redirect_uri'), challenge: q.get('code_challenge'), state: q.get('state') || '' }), hash(csrf), now() + 600000);
        res.setHeader('Set-Cookie', `${cookieName('dot_consent')}=${csrf}; ${cookieOptions}; Max-Age=600`);
        allowOAuthRedirect(q.get('redirect_uri'));
        return html(consent(ticket, client.client_name, csrf));
      }
      if (route === '/consent' && req.method === 'POST') {
        const data = form(await body(req, 8192));
        const entry = store.get('SELECT * FROM tickets WHERE id=? AND expires>?', data.get('ticket'), now());
        if (!entry || req.headers.origin !== origin || !equal(entry.csrf, hash(cookie('dot_consent') || '')) || !equal(cookie('dot_consent'), data.get('csrf'))) fail('invalid_consent', 403);
        const ticket = JSON.parse(entry.data), destination = new URL(ticket.redirect); destination.searchParams.set('iss', origin); if (ticket.state) destination.searchParams.set('state', ticket.state);
        allowOAuthRedirect(ticket.redirect);
        if (data.get('decision') === 'deny') { store.run('DELETE FROM tickets WHERE id=?', entry.id); destination.searchParams.set('error', 'access_denied'); return redirect(destination.href); }
        if (data.get('decision') !== 'allow') fail('invalid_request');
        store.rate('login:' + remote, 30);
        const owner = store.ownerKey(data.get('key') || '') || fail('invalid_account_key', 401);
        store.box(owner.id, data.get('box'));
        const code = token();
        store.transaction(() => {
          store.run('DELETE FROM tickets WHERE id=?', entry.id);
          if (store.get('SELECT count(*) AS n FROM grants WHERE owner=? AND revoked=0 AND expires>?', owner.id, now()).n >= 30) fail('connection_limit');
          const grant = { id: id(), owner: owner.id, box: data.get('box'), client: ticket.client, expires: now() + 30 * 86400000 };
          store.run('INSERT INTO grants VALUES(?,?,?,?,?,0)', grant.id, grant.owner, grant.box, grant.client, grant.expires);
          store.run('INSERT INTO credentials VALUES(?,?,?,?,0,?)', hash(code), grant.id, 'code', now() + 60000, JSON.stringify({ redirect: ticket.redirect, challenge: ticket.challenge }));
        });
        destination.searchParams.set('code', code); return redirect(destination.href);
      }
      if (route === '/token' && req.method === 'POST') {
        const data = form(await body(req, 8192)); if (data.get('resource') !== resource) fail('invalid_target');
        const kind = data.get('grant_type') === 'authorization_code' ? 'code' : data.get('grant_type') === 'refresh_token' ? 'refresh' : fail('unsupported_grant_type');
        const grant = store.auth(data.get(kind === 'code' ? 'code' : 'refresh_token') || '', kind);
        if (grant.client !== data.get('client_id') || (data.has('scope') && data.get('scope') !== 'mailbox')) fail('invalid_grant');
        // A replayed code or refresh token revokes every token issued from that grant.
        if (grant.used) { store.revoke(grant.id); fail('invalid_grant'); }
        if (kind === 'code') {
          const saved = JSON.parse(grant.credential_data), verifier = data.get('code_verifier') || '';
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || saved.redirect !== data.get('redirect_uri') || !equal(saved.challenge, Buffer.from(hash(verifier), 'hex').toString('base64url'))) fail('invalid_grant');
        }
        store.rate('token:' + grant.owner, 60);
        return json(200, store.transaction(() => { store.run('UPDATE credentials SET used=1 WHERE hash=?', grant.credential_hash); return store.issue(grant); }));
      }
      if (route === '/revoke' && req.method === 'POST') {
        const data = form(await body(req, 8192));
        const grant = store.get('SELECT g.* FROM credentials c JOIN grants g ON g.id=c.grant_id WHERE c.hash=?', hash(data.get('token') || ''));
        if (grant && grant.client === data.get('client_id')) store.revoke(grant.id);
        return json(200, {});
      }
      if (req.method === 'POST' && ['/worker-setup/start', '/worker-setup/poll', '/worker-setup/finish'].includes(route)) {
        const input = JSON.parse(await body(req, 8192));
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_setup');
        if (route === '/worker-setup/start') return json(200, workerSetup.begin(input, remote));
        return json(200, route === '/worker-setup/poll' ? workerSetup.poll(input.device_secret) : workerSetup.finish(input.device_secret));
      }
      if (route === '/mcp') {
        let grant; const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] || '';
        try { grant = store.auth(bearer); } catch { res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mailbox"`); return json(401, { error: 'invalid_token' }); }
        store.rate('mcp:' + grant.owner, 180);
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(405, { error: 'method_not_allowed' }); }
        const raw = await body(req, 65536);
        const envelope = JSON.parse(raw);
        if (!envelope || Array.isArray(envelope) || !['initialize', 'notifications/initialized', 'ping', 'server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe'].includes(envelope.method)) return json(400, { error: 'unsupported_method' });
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        for (const name of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) if (req.headers[name]) headers[name] = String(req.headers[name]);
        const request = new Request(resource, { method: 'POST', headers, body: raw });
        const response = await mcp.fetch(request, { authInfo: { token: bearer, clientId: grant.client, scopes: ['mailbox'] } });
        res.statusCode = response.status;
        for (const [key, value] of response.headers) res.setHeader(key, value);
        res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const sessionToken = cookie('dot_session');
      const session = sessionToken && store.get('SELECT s.* FROM sessions s JOIN owners o ON o.id=s.owner WHERE s.hash=? AND s.expires>? AND o.disabled=0', hash(sessionToken), now());
      if (route === '/connect' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) return html(page('Connect a worker', '<p>Run <code>ninja-p2p worker setup</code> on the computer where your agent will work, then enter the code it shows.</p><form method="get" action="/connect"><label>Connection code<input name="code" required maxlength="14" autocomplete="off" placeholder="ABCD-1234-EF56"></label><button>Continue</button></form>'));
        try { workerSetup.byCode(code); }
        catch (error) {
          if (error.status !== 410 && error.message !== 'invalid_setup_code') throw error;
          return html(page('Check your connection code', '<p>This code is invalid or has expired. Run <code>ninja-p2p worker setup</code> again for a new code, then open the link shown in your terminal.</p><p><a href="/connect">Enter a connection code</a></p>'));
        }
        if (session) return html(workerSetup.render(session, code));
        const csrf = token(); res.setHeader('Set-Cookie', `${cookieName('dot_login')}=${csrf}; ${cookieOptions}; Max-Age=600`);
        return html(login(csrf, setupCode(code)));
      }
      if (route === '/connect/approve' && req.method === 'POST') {
        if (!session) fail('sign_in_required', 401);
        const data = form(await body(req, 8192));
        if (req.headers.origin !== origin || !equal(session.csrf, data.get('csrf'))) fail('invalid_csrf', 403);
        store.rate('connect:' + session.owner, 30);
        workerSetup.approve(session, Object.fromEntries(data));
        return redirect('/connect?code=' + setupCode(data.get('code')));
      }
      if (route === '/tasks' && req.method === 'GET') {
        if (!session) return redirect('/');
        return html(taskPage(store, session, url.searchParams.get('box'), url.searchParams.get('task'), url.searchParams.get('after') || ''));
      }
      if (['/tasks/create', '/tasks/decide', '/tasks/cancel'].includes(route) && req.method === 'POST') {
        if (!session) fail('sign_in_required', 401);
        const data = form(await body(req, 24000));
        if (req.headers.origin !== origin || !equal(session.csrf, data.get('csrf'))) fail('invalid_csrf', 403);
        store.rate('portal:' + session.owner, 120);
        const box = store.box(session.owner, data.get('box'));
        let task;
        if (route === '/tasks/create') task = store.tasks.create(box.id, { recipient_id: data.get('recipient_id'), title: data.get('title'), request: data.get('request'), request_key: data.get('request_key'), expires_at: data.get('expires_at') }, true);
        else {
          const current = store.tasks.row(box.id, data.get('task_id'));
          if (current.requester !== box.id) fail('Only the requester can decide or cancel.', 403);
          const args = { task_id: current.id, revision: Number(data.get('revision')), request_key: data.get('request_key'), note: data.get('note') };
          task = route === '/tasks/decide' ? store.tasks.decide(session.owner, { ...args, decision: data.get('decision') }) : store.tasks.cancel(box.id, args, true);
        }
        return redirect('/tasks?box=' + box.id + '&task=' + task.task_id);
      }
      if (route === '/' && req.method === 'GET') {
        if (session) return html(dashboard(store, session, url.searchParams.get('box')));
        const csrf = token(); res.setHeader('Set-Cookie', `${cookieName('dot_login')}=${csrf}; ${cookieOptions}; Max-Age=600`); return html(login(csrf));
      }
      if (route === '/login' && req.method === 'POST') {
        const data = form(await body(req, 8192));
        if (req.headers.origin !== origin || !equal(cookie('dot_login'), data.get('csrf'))) fail('invalid_csrf', 403);
        store.rate('login:' + remote, 30);
        const owner = store.ownerKey(data.get('key') || '') || fail('invalid_account_key', 401);
        const value = token();
        if (store.get('SELECT count(*) AS n FROM sessions WHERE owner=? AND expires>?', owner.id, now()).n >= 20) fail('session_limit', 429);
        store.run('INSERT INTO sessions VALUES(?,?,?,?)', hash(value), owner.id, token(), now() + 8 * 3600000);
        res.setHeader('Set-Cookie', `${cookieName('dot_session')}=${value}; ${cookieOptions}; Max-Age=28800`);
        return redirect(validSetupCode(data.get('setup_code')) ? '/connect?code=' + setupCode(data.get('setup_code')) : '/');
      }
      if (req.method === 'POST' && ['/boxes', '/messages', '/disconnect', '/logout'].includes(route)) {
        if (!session) fail('sign_in_required', 401);
        const data = form(await body(req, 65536));
        if (req.headers.origin !== origin || !equal(session.csrf, data.get('csrf'))) fail('invalid_csrf', 403);
        store.rate('portal:' + session.owner, 120);
        if (route === '/logout') { store.run('DELETE FROM sessions WHERE hash=?', session.hash); res.setHeader('Set-Cookie', `${cookieName('dot_session')}=; ${cookieOptions}; Max-Age=0`); return redirect('/'); }
        if (route === '/boxes') { const label = data.get('label')?.trim(); if (!label || label.length > 80) fail('invalid_label'); return redirect('/?box=' + store.createBox(session.owner, label)); }
        if (route === '/disconnect') { const grant = store.get('SELECT id FROM grants WHERE id=? AND owner=?', data.get('grant'), session.owner) || fail('not_found', 404); store.revoke(grant.id); return redirect('/'); }
        const box = store.box(session.owner, data.get('box')), text = data.get('text'), key = data.get('request_key');
        if (!text || !/^[A-Za-z0-9_-]{8,100}$/.test(key || '')) fail('invalid_message');
        store.send(box.id, 'owner', box.id, text, key); return redirect('/?box=' + box.id);
      }
      return json(404, { error: 'not_found' });
    } catch (error) {
      if (!res.headersSent) { if (error.status === 429) res.setHeader('Retry-After', '60'); json(error.status || 400, { error: error.status ? error.message : 'invalid_request' }); } else res.end();
    } finally { if (counted) inflight--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 64; server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.PORT || 8789), options.host || '127.0.0.1', resolve); });
  return { server, store, delivery, async close() { stopping = true; clearInterval(maintenance); await delivery?.stop(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await mcp.close(); store.db.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  start({ trustProxy: true }).then(instance => {
    console.log('Dot mailbox listening on loopback');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void instance.close().then(() => process.exit(0)));
  }).catch(() => { console.error('Dot mailbox startup failed; check service configuration'); process.exitCode = 1; });
}
