import { z } from 'zod';
import { hash, id, now, fail } from './store.mjs';

const boxId = z.string().regex(/^[a-f0-9]{32}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const boundedText = max => z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= max, 'Text too large');
const artifact = z.object({ label: boundedText(160), url: z.string().max(2048).url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}, 'Use an HTTPS reference without credentials') }).strict();
export const createTaskSchema = z.object({ recipient_id: boxId, title: boundedText(160), request: boundedText(8000),
  request_key: key, expires_at: z.string().datetime() }).strict();
export const updateTaskSchema = z.object({ task_id: boxId, revision: z.number().int().positive(), request_key: key,
  action: z.enum(['start', 'progress', 'request_approval', 'complete', 'fail', 'cancelled']),
  note: boundedText(2000), progress: z.number().int().min(0).max(100).optional(),
  result: boundedText(8000).optional(), artifacts: z.array(artifact).max(5).optional() }).strict();
export const taskIdSchema = z.object({ task_id: boxId }).strict();
export const listTasksSchema = z.object({ after: boxId.optional() }).strict();
export const cancelTaskSchema = z.object({ task_id: boxId, revision: z.number().int().positive(), request_key: key,
  note: boundedText(2000) }).strict();
const decisionSchema = cancelTaskSchema.extend({ decision: z.enum(['approved', 'declined']) });
const terminal = new Set(['completed', 'failed', 'cancelled']);
const week = 7 * 86400000;

/** A task is an opt-in record; ordinary messages never become executable work. */
export class Tasks {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, requester TEXT NOT NULL REFERENCES boxes(id), worker TEXT NOT NULL REFERENCES boxes(id),
      owner TEXT NOT NULL REFERENCES owners(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
      body TEXT NOT NULL, bytes INTEGER NOT NULL, UNIQUE(requester,request_key));
      CREATE INDEX IF NOT EXISTS tasks_requester ON tasks(requester,id);
      CREATE INDEX IF NOT EXISTS tasks_worker ON tasks(worker,id);
      CREATE TABLE IF NOT EXISTS task_events(
      task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
      actor TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created INTEGER NOT NULL,
      body TEXT NOT NULL, bytes INTEGER NOT NULL, message TEXT NOT NULL,
      PRIMARY KEY(task,revision), UNIQUE(task,actor,request_key));`);
  }
  row(box, taskId) {
    return this.store.get('SELECT * FROM tasks WHERE id=? AND (requester=? OR worker=?)', taskId, box, box) || fail('task_not_found', 404);
  }
  data(row) { return this.store.open(row.body, 'task:' + row.id); }
  summary(row) {
    return { task_id: row.id, requester_id: row.requester, worker_id: row.worker,
      status: !terminal.has(row.status) && row.expires <= now() ? 'expired' : row.status,
      revision: row.revision, created_at: new Date(row.created).toISOString(), expires_at: new Date(row.expires).toISOString(), ...this.data(row) };
  }
  get(box, taskId) {
    const row = this.row(box, taskId);
    return { ...this.summary(row), events: this.store.all('SELECT * FROM task_events WHERE task=? ORDER BY revision', taskId).map(event => ({
      revision: event.revision, actor: event.actor.startsWith('owner:') ? 'requester owner' : event.actor, created_at: new Date(event.created).toISOString(),
      ...this.store.open(event.body, 'task-event:' + taskId + ':' + event.revision),
      notification: { stage: this.store.get('SELECT 1 FROM messages WHERE id=?', event.message) ? 'stored' : 'retention_expired',
        message_id: event.message, webhooks: this.store.all('SELECT state,status FROM deliveries WHERE message=?', event.message) },
    })) };
  }
  list(box, after = '') {
    const rows = this.store.all('SELECT * FROM tasks WHERE (requester=? OR worker=?) AND id>? ORDER BY id LIMIT 51', box, box, after);
    return { tasks: rows.slice(0, 50).map(row => this.summary(row)), next_cursor: rows.length > 50 ? rows[49].id : null };
  }
  capacity(owner, bytes) {
    const usage = scope => this.store.get(`SELECT coalesce(sum(bytes),0) AS n FROM (
      SELECT bytes FROM tasks ${scope ? 'WHERE owner=?' : ''} UNION ALL
      SELECT e.bytes FROM task_events e JOIN tasks t ON t.id=e.task ${scope ? 'WHERE t.owner=?' : ''})`, ...(scope ? [owner, owner] : [])).n;
    if (usage(true) + bytes > 8 * 1024 * 1024) fail('task_account_storage_limit', 409);
    if (usage(false) + bytes > 128 * 1024 * 1024) fail('task_service_storage_limit', 503);
  }
  create(box, input, ownerAction = false) {
    const args = createTaskSchema.parse(input), fingerprint = hash(JSON.stringify(args));
    return this.store.transaction(() => {
      const previous = this.store.get('SELECT * FROM tasks WHERE requester=? AND request_key=?', box, args.request_key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('idempotency_conflict', 409);
        return { ...this.get(box, previous.id), duplicate: true };
      }
      const expires = Date.parse(args.expires_at), time = now();
      if (expires <= time || expires > time + week) fail('Task expiry must be in the next seven days.');
      const source = this.store.get('SELECT owner FROM boxes WHERE id=?', box) || fail('not_found', 404);
      if (this.store.get('SELECT count(*) AS n FROM tasks WHERE owner=?', source.owner).n >= 100 ||
          this.store.get('SELECT count(*) AS n FROM tasks').n >= 2000) fail('task_limit', 409);
      const taskId = id(), data = { title: args.title, request: args.request, note: 'Waiting for the worker to accept.', progress: 0 };
      const bytes = Buffer.byteLength(JSON.stringify(data)); this.capacity(source.owner, bytes);
      this.store.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', taskId, box, args.recipient_id, source.owner,
        args.request_key, fingerprint, 'submitted', 1, time, expires, this.store.seal(data, 'task:' + taskId), bytes);
      const row = this.row(box, taskId);
      this.event(row, ownerAction ? 'owner:' + source.owner : 'mailbox:' + box, args, 'submitted', data, box, args.recipient_id, ownerAction);
      return { ...this.get(box, taskId), duplicate: false };
    });
  }
  event(row, actor, args, action, data, sender, target, ownerAction = false) {
    const event = { action, status: row.status, note: data.note, progress: data.progress,
      ...(action === 'submitted' ? { title: data.title, request: data.request } : {}),
      ...(data.approval ? { approval: data.approval } : {}),
      ...(data.result ? { result: data.result, artifacts: data.artifacts || [] } : {}) };
    const body = JSON.stringify(event), bytes = Buffer.byteLength(body);
    if (bytes > 14000) fail('task_event_too_large');
    this.capacity(row.owner, bytes);
    // The state change, notification and webhook queue commit together.
    const notification = this.store.insertMessage(sender, ownerAction ? 'owner' : 'dot', target,
      JSON.stringify({ type: 'ninja.task', version: 1, task_id: row.id, revision: row.revision, ...event }),
      'task_' + row.id + '_' + row.revision);
    this.store.run('INSERT INTO task_events VALUES(?,?,?,?,?,?,?,?,?)', row.id, row.revision, actor,
      args.request_key, hash(JSON.stringify(args)), now(), this.store.seal(event, 'task-event:' + row.id + ':' + row.revision), bytes, notification.id);
  }
  change(box, args, actor, apply, notifyWorker = false, ownerAction = false) {
    return this.store.transaction(() => {
      const row = this.row(box, args.task_id);
      const previous = this.store.get('SELECT * FROM task_events WHERE task=? AND actor=? AND request_key=?', row.id, actor, args.request_key);
      if (previous) {
        if (previous.fingerprint !== hash(JSON.stringify(args))) fail('idempotency_conflict', 409);
        return { ...this.get(box, row.id), duplicate: true, applied_revision: previous.revision };
      }
      if (row.expires <= now()) fail('task_expired', 409);
      if (terminal.has(row.status)) fail('task_already_finished', 409);
      if (row.revision !== args.revision) fail('task_revision_conflict; read the current task before changing it', 409);
      if (row.revision >= 64 || (row.revision >= 60 && ['start', 'progress', 'request_approval'].includes(args.action))) fail('task_update_limit', 409);
      const data = this.data(row);
      const action = apply(row, data);
      row.revision++;
      const bytes = Buffer.byteLength(JSON.stringify(data)); this.capacity(row.owner, Math.max(0, bytes - row.bytes));
      this.store.run('UPDATE tasks SET status=?,revision=?,body=?,bytes=? WHERE id=?', row.status, row.revision,
        this.store.seal(data, 'task:' + row.id), bytes, row.id);
      this.event(row, actor, args, action, data, notifyWorker ? row.requester : row.worker,
        notifyWorker ? row.worker : row.requester, ownerAction);
      return { ...this.get(box, row.id), duplicate: false, applied_revision: row.revision };
    });
  }
  update(box, input) {
    const args = updateTaskSchema.parse(input);
    if (this.row(box, args.task_id).worker !== box) fail('Only the assigned worker can report progress.', 403);
    return this.change(box, args, 'mailbox:' + box, (row, data) => {
      const allowed = { start: ['submitted'], progress: ['working'], request_approval: ['working'],
        complete: ['working', 'cancel_requested'], fail: ['submitted', 'working', 'awaiting_approval', 'cancel_requested'],
        cancelled: ['submitted', 'working', 'awaiting_approval', 'cancel_requested'] };
      if (!allowed[args.action].includes(row.status)) fail('invalid_task_transition', 409);
      if (args.action === 'complete' && !args.result) fail('Completion requires a result.');
      if (args.action !== 'complete' && (args.result !== undefined || args.artifacts !== undefined)) fail('Only completion accepts results and artifacts.');
      if (args.action === 'request_approval') data.approval = { id: id(), summary: args.note, status: 'pending' };
      if (args.action === 'complete') { data.result = args.result; data.artifacts = args.artifacts || []; }
      data.note = args.note;
      if (args.progress !== undefined) {
        if (args.progress < data.progress) fail('Progress must not decrease.');
        data.progress = args.progress;
      }
      if (args.action === 'complete') data.progress = 100;
      row.status = { start: 'working', progress: 'working', request_approval: 'awaiting_approval',
        complete: 'completed', fail: 'failed', cancelled: 'cancelled' }[args.action];
      return args.action;
    });
  }
  cancel(box, input, ownerAction = false) {
    const args = cancelTaskSchema.parse(input), row = this.row(box, args.task_id);
    if (row.requester !== box) fail('Only the requester can ask to cancel.', 403);
    return this.change(box, args, ownerAction ? 'owner:' + row.owner : 'mailbox:' + box, (row, data) => {
      if (row.status === 'cancel_requested') fail('Cancellation already requested.', 409);
      row.status = 'cancel_requested'; data.note = args.note; return 'cancel_requested';
    }, true, ownerAction);
  }
  decide(owner, input) {
    const args = decisionSchema.parse(input);
    const row = this.store.get('SELECT * FROM tasks WHERE id=? AND owner=?', args.task_id, owner) || fail('task_not_found', 404);
    return this.change(row.requester, args, 'owner:' + owner, (row, data) => {
      if (row.status !== 'awaiting_approval' || data.approval?.status !== 'pending') fail('No pending approval.', 409);
      data.approval = { ...data.approval, status: args.decision, decided_at: new Date(now()).toISOString() };
      data.note = args.note; row.status = 'working'; return args.decision;
    }, true, true);
  }
  cleanup() { this.store.run('DELETE FROM tasks WHERE expires<?', now() - week); }
}
