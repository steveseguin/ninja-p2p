import { randomBytes } from 'node:crypto';
import { hash, now, fail } from './store.mjs';
import { issueAgentCredential } from './agent-credential.mjs';
import { page, escape } from './pages.mjs';

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
export const setupCode = value => String(value || '').toUpperCase().replace(/-/g, '');
export const validSetupCode = value => /^[A-F0-9]{12}$/.test(setupCode(value));
const displayCode = value => value.match(/.{4}/g).join('-');
const firstRequest = 'Read README.md in the selected project if it exists. In at most 120 words, explain what the project does and suggest one useful next step, citing the files you read. If there is no README, inspect only the top-level file names and say what information is missing. Read-only review: no edits, installs, secrets, external services or unrelated work.';

/** A browser-approved connection for a new worker. Existing grants and peers are untouched. */
export class WorkerSetup {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS worker_setups(
      device TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, agent TEXT NOT NULL,
      label TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL,
      owner TEXT, worker TEXT, requester TEXT, task TEXT, sealed TEXT);
      CREATE INDEX IF NOT EXISTS worker_setups_expiry ON worker_setups(expires);`);
  }
  cleanup() { this.store.run('DELETE FROM worker_setups WHERE expires<=?', now()); }
  begin(input, remote) {
    this.cleanup();
    if (!secretPattern.test(input.device_secret || '') || !['codex', 'opencode'].includes(input.agent) ||
        typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(input.label)) fail('invalid_setup');
    const device = hash(input.device_secret), label = input.label.trim();
    let row = this.store.get('SELECT * FROM worker_setups WHERE device=?', device);
    if (row && (row.agent !== input.agent || row.label !== label)) fail('setup_conflict', 409);
    if (!row) {
      this.store.rate('setup:' + remote.slice(0, 100), 20, 3600000);
      this.store.rate('setup:global', 300, 3600000);
      if (this.store.get('SELECT count(*) AS n FROM worker_setups').n >= 500) fail('setup_busy', 503);
      const code = randomBytes(6).toString('hex').toUpperCase();
      this.store.run('INSERT INTO worker_setups(device,code,agent,label,expires,status) VALUES(?,?,?,?,?,?)', device, code, input.agent, label, now() + 600000, 'pending');
      row = this.store.get('SELECT * FROM worker_setups WHERE device=?', device);
    }
    return { code: displayCode(row.code), verification_url: this.store.origin + '/connect?code=' + displayCode(row.code), expires_at: new Date(row.expires).toISOString(), interval: 3 };
  }
  device(secret) {
    if (!secretPattern.test(secret || '')) fail('invalid_setup');
    return this.store.get('SELECT * FROM worker_setups WHERE device=? AND expires>?', hash(secret), now()) || fail('setup_expired', 410);
  }
  poll(secret) {
    const row = this.device(secret);
    this.store.rate('setup-poll:' + row.device, 30);
    if (row.status !== 'approved') return { status: row.status };
    const value = this.store.open(row.sealed, 'worker-setup:' + row.device);
    this.store.auth(value.credential.token);
    return { status: 'approved', ...value };
  }
  finish(secret) {
    const row = this.device(secret);
    if (!['approved', 'received'].includes(row.status)) fail('setup_not_approved', 409);
    this.store.run("UPDATE worker_setups SET status='received',sealed=NULL WHERE device=?", row.device);
    return { status: 'received' };
  }
  byCode(code) {
    if (!validSetupCode(code)) fail('invalid_setup_code');
    return this.store.get('SELECT * FROM worker_setups WHERE code=? AND expires>?', setupCode(code), now()) || fail('setup_expired', 410);
  }
  approve(session, input) {
    return this.store.transaction(() => {
      const row = this.byCode(input.code);
      if (row.status !== 'pending') {
        if (row.owner !== session.owner) fail('setup_unavailable', 409);
        return row;
      }
      if (input.decision === 'deny') {
        this.store.run("UPDATE worker_setups SET status='denied',owner=? WHERE device=?", session.owner, row.device);
        return this.byCode(row.code);
      }
      if (input.decision !== 'allow') fail('invalid_decision');
      const requester = this.store.box(session.owner, input.requester);
      if (this.store.get('SELECT count(*) AS n FROM peers WHERE a=?', requester.id).n >= 20) fail('peer_limit');
      const worker = this.store.createBox(session.owner, row.label);
      const credential = issueAgentCredential(this.store, worker, this.store.origin, true);
      this.store.run('INSERT INTO peers VALUES(?,?),(?,?)', requester.id, worker, worker, requester.id);
      const task = input.first_task === 'yes' ? this.store.tasks.create(requester.id, {
        recipient_id: worker, title: 'First task: review the project', request: firstRequest,
        request_key: 'setup_' + row.device, expires_at: new Date(now() + 3600000).toISOString(),
      }, true, true) : null;
      const sealed = this.store.seal({ credential, requester: { id: requester.id, label: requester.label }, first_task_id: task?.task_id || null }, 'worker-setup:' + row.device);
      this.store.run("UPDATE worker_setups SET status='approved',owner=?,worker=?,requester=?,task=?,sealed=? WHERE device=?", session.owner, worker, requester.id, task?.task_id || null, sealed, row.device);
      return this.byCode(row.code);
    });
  }
  render(session, code) {
    const row = this.byCode(code), shown = displayCode(row.code);
    if (row.status !== 'pending') {
      if (row.owner !== session.owner) return page('Connection unavailable', '<p>This connection code has already been used.</p>');
      if (row.status === 'denied') return page('Connection declined', '<p>No worker was connected.</p>');
      return page('Worker connected', `<p><strong>${escape(row.label)}</strong> is paired. Return to your terminal to finish starting the worker.</p>${row.task ? `<p><a href="/tasks?box=${row.requester}&task=${row.task}">Follow your first task</a></p>` : ''}<p><a href="/?box=${row.worker}">Manage this worker connection</a></p>`);
    }
    const boxes = this.store.all('SELECT id,label FROM boxes WHERE owner=? ORDER BY created', session.owner);
    if (!boxes.length) return page('Connect your requester first', '<p>Create a mailbox for the Dot or agent that will request work, then return to the connection link in your terminal.</p><p><a href="/">Create your requester mailbox</a></p>');
    return page('Connect your worker', `<p>Match this code with the terminal where you started setup:</p><h2><code>${shown}</code></h2><p>Worker: <strong>${escape(row.label)}</strong> (${row.agent === 'codex' ? 'Codex' : 'OpenCode'}).</p><p>This creates a separate mailbox for this worker and pairs it with the requester you select. That requester can send it tasks. The worker starts with read-only access to the project folder you selected in your terminal, using your agent CLI's existing login.</p><form method="post" action="/connect/approve"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="code" value="${shown}"><label>Which agent will request work?<select name="requester" required>${boxes.map(box => `<option value="${box.id}">${escape(box.label)} · ${box.id.slice(0, 8)}</option>`).join('')}</select></label><label><input style="display:inline;width:auto" type="checkbox" name="first_task" value="yes" checked> Run a first read-only task: summarize the project's README and suggest one next step.</label><p><small>The worker uses your CLI account for model usage. Its mailbox credential lasts 30 days and can be revoked on this website. Approve only a code from your own setup terminal.</small></p><button name="decision" value="allow">Connect worker</button> <button name="decision" value="deny">Decline</button></form>`);
  }
}
