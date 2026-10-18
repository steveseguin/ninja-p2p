import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export const token = () => randomBytes(32).toString('base64url');
export const id = () => randomBytes(16).toString('hex');
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export const now = () => Date.now();

export class Store {
  constructor(root, secret) {
    if (!/^[a-f0-9]{64}$/i.test(secret || '')) throw new Error('DOT_SECRET must be 64 hex characters.');
    this.key = Buffer.from(secret, 'hex');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, 'mailbox.sqlite'));
    chmodSync(path.join(root, 'mailbox.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS boxes(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), label TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS boxes_owner ON boxes(owner);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, data TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), box TEXT NOT NULL REFERENCES boxes(id), client TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), kind TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, data TEXT);
      CREATE INDEX IF NOT EXISTS credentials_grant ON credentials(grant_id);
      CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY, box TEXT NOT NULL REFERENCES boxes(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS peers(a TEXT NOT NULL REFERENCES boxes(id), b TEXT NOT NULL REFERENCES boxes(id), PRIMARY KEY(a,b));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, box TEXT NOT NULL REFERENCES boxes(id), sender TEXT NOT NULL, actor TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, reply_to TEXT, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, mailseq INTEGER NOT NULL DEFAULT 0, UNIQUE(sender,actor,request_key));
      CREATE TABLE IF NOT EXISTS mailbox_sequences(box TEXT PRIMARY KEY REFERENCES boxes(id), sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(key TEXT PRIMARY KEY, messages INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS message_added AFTER INSERT ON messages BEGIN
        INSERT INTO usage VALUES('global',1,NEW.bytes) ON CONFLICT(key) DO UPDATE SET messages=messages+1,bytes=bytes+NEW.bytes;
        INSERT INTO usage VALUES((SELECT owner FROM boxes WHERE id=NEW.box),1,NEW.bytes) ON CONFLICT(key) DO UPDATE SET messages=messages+1,bytes=bytes+NEW.bytes;
      END;
      CREATE TRIGGER IF NOT EXISTS message_removed AFTER DELETE ON messages BEGIN
        UPDATE usage SET messages=messages-1,bytes=bytes-OLD.bytes WHERE key='global' OR key=(SELECT owner FROM boxes WHERE id=OLD.box);
      END;
      CREATE INDEX IF NOT EXISTS messages_box ON messages(box,seq);
      CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender,seq);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), box TEXT NOT NULL REFERENCES boxes(id), callback_hash TEXT NOT NULL, sealed TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS subscriptions_box ON subscriptions(box,active);
      CREATE TABLE IF NOT EXISTS deliveries(sub TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, message TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', status INTEGER, PRIMARY KEY(sub,message));
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state,due);
      CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
    `);
    // Keep public cursors mailbox-local, so gaps do not disclose other users' traffic.
    if (!this.all('PRAGMA table_info(messages)').some(column => column.name === 'mailseq')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN mailseq INTEGER NOT NULL DEFAULT 0');
      this.db.exec('WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY box ORDER BY seq) AS n FROM messages) UPDATE messages SET mailseq=(SELECT n FROM numbered WHERE numbered.id=messages.id)');
    }
    this.db.exec('INSERT OR IGNORE INTO mailbox_sequences SELECT box,max(mailseq) FROM messages GROUP BY box; CREATE UNIQUE INDEX IF NOT EXISTS messages_local_sequence ON messages(box,mailseq)');
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  open(value, context) {
    const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }
  identity(value) { return createHmac('sha256', this.key).update(value).digest('hex'); }
  rate(key, limit, duration = 60000) {
    const entry = this.get('SELECT * FROM rates WHERE key=?', key), time = now();
    if (entry && entry.until > time && entry.count >= limit) fail('rate_limited', 429);
    this.run('INSERT INTO rates VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, until=excluded.until', key, entry && entry.until > time ? entry.count + 1 : 1, entry && entry.until > time ? entry.until : time + duration);
  }
  ownerKey(key) { return this.get('SELECT * FROM owners WHERE key_hash=? AND disabled=0', hash(key)); }
  box(owner, box) { return this.get('SELECT * FROM boxes WHERE owner=? AND id=?', owner, box) || fail('not_found', 404); }
  createBox(owner, label) {
    if (this.get('SELECT count(*) AS n FROM boxes WHERE owner=?', owner).n >= 20) fail('mailbox_limit', 409);
    const box = id(); this.run('INSERT INTO boxes VALUES(?,?,?,?)', box, owner, label, now()); return box;
  }
  auth(value, kind = 'access') {
    const result = this.get(`SELECT g.*,c.hash AS credential_hash,c.used,c.data AS credential_data FROM credentials c JOIN grants g ON g.id=c.grant_id JOIN owners o ON o.id=g.owner WHERE c.hash=? AND c.kind=? AND c.expires>? AND g.expires>? AND g.revoked=0 AND o.disabled=0`, hash(value), kind, now(), now());
    return result || fail('invalid_token', 401);
  }
  issue(grant) {
    const access = token(), refresh = token(), expires = Math.min(now() + 3600000, grant.expires);
    this.run('INSERT INTO credentials VALUES(?,?,?,?,0,NULL)', hash(access), grant.id, 'access', expires);
    this.run('INSERT INTO credentials VALUES(?,?,?,?,0,NULL)', hash(refresh), grant.id, 'refresh', grant.expires);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor((expires - now()) / 1000), refresh_token: refresh, scope: 'mailbox' };
  }
  revoke(grant) {
    this.run('UPDATE grants SET revoked=1 WHERE id=?', grant);
    this.run('DELETE FROM subscriptions WHERE grant_id=?', grant);
    this.run('DELETE FROM credentials WHERE grant_id=?', grant);
  }
  message(row) {
    return { id: row.id, sequence: row.mailseq, mailbox_id: row.box, sender_id: row.sender, sender_type: row.actor, text: this.open(row.body, 'message:' + row.box + ':' + row.id), created_at: new Date(row.created).toISOString(), reply_to: row.reply_to };
  }
  read(box, after = 0) { return this.all('SELECT * FROM messages WHERE box=? AND mailseq>? ORDER BY mailseq LIMIT 50', box, after).map(row => this.message(row)); }
  send(sender, actor, target, text, requestKey, replyTo = null) {
    if (Buffer.byteLength(text) > 16000) fail('message_too_large', 413);
    const fingerprint = hash(JSON.stringify([target, text, replyTo]));
    return this.transaction(() => {
      const previous = this.get('SELECT * FROM messages WHERE sender=? AND actor=? AND request_key=?', sender, actor, requestKey);
      if (previous) { if (previous.fingerprint !== fingerprint) fail('idempotency_conflict', 409); return { id: previous.id, duplicate: true }; }
      const source = this.get('SELECT b.* FROM boxes b JOIN owners o ON o.id=b.owner WHERE b.id=? AND o.disabled=0', sender);
      const recipient = this.get('SELECT b.* FROM boxes b JOIN owners o ON o.id=b.owner WHERE b.id=? AND o.disabled=0', target);
      if (!source || !recipient) fail('not_found', 404);
      if (sender !== target && !this.get('SELECT 1 FROM peers WHERE a=? AND b=?', sender, target)) fail('peer_not_paired', 403);
      const bytes = Buffer.byteLength(text);
      const ownerUsage = this.get('SELECT * FROM usage WHERE key=?', recipient.owner);
      const totalUsage = this.get("SELECT * FROM usage WHERE key='global'");
      if (ownerUsage && (ownerUsage.messages >= 5000 || ownerUsage.bytes + bytes > 32 * 1024 * 1024)) fail('account_storage_limit', 409);
      if (totalUsage && (totalUsage.messages >= 100000 || totalUsage.bytes + bytes > 512 * 1024 * 1024)) fail('service_storage_limit', 503);
      this.rate('send:' + source.owner, 60);
      this.rate('receive:' + target, 120);
      if (this.get('SELECT count(*) AS n FROM messages WHERE box=?', target).n >= 2000) fail('mailbox_full', 409);
      if (this.get("SELECT count(*) AS n FROM deliveries WHERE state='pending'").n >= 20000) fail('delivery_queue_full', 503);
      if (this.get("SELECT count(*) AS n FROM deliveries d JOIN subscriptions s ON s.id=d.sub JOIN boxes b ON b.id=s.box WHERE b.owner=? AND d.state='pending'", recipient.owner).n >= 500) fail('account_delivery_queue_full', 429);
      const message = id(), sealed = this.seal(text, 'message:' + target + ':' + message);
      this.run('INSERT INTO mailbox_sequences VALUES(?,1) ON CONFLICT(box) DO UPDATE SET sequence=sequence+1', target);
      const sequence = this.get('SELECT sequence FROM mailbox_sequences WHERE box=?', target).sequence;
      this.run('INSERT INTO messages(id,box,sender,actor,body,created,reply_to,request_key,fingerprint,bytes,mailseq) VALUES(?,?,?,?,?,?,?,?,?,?,?)', message, target, sender, actor, sealed, now(), replyTo, requestKey, fingerprint, bytes, sequence);
      // A Dot's reply to its owner stays in the portal without waking the same Dot again.
      if (actor === 'owner' || sender !== target || actor === 'self-test') {
        this.run(`INSERT INTO deliveries(sub,message,due) SELECT s.id,?,? FROM subscriptions s JOIN grants g ON g.id=s.grant_id WHERE s.box=? AND s.active=1 AND s.expires>? AND g.revoked=0 AND g.expires>?`, message, now(), target, now(), now());
      }
      return { id: message, duplicate: false };
    });
  }
  cleanup() {
    this.transaction(() => {
      for (const table of ['tickets', 'sessions', 'invitations']) this.run(`DELETE FROM ${table} WHERE expires<?`, now());
      this.run('DELETE FROM rates WHERE until<?', now());
      this.run('DELETE FROM credentials WHERE expires<?', now());
      // Registration is public: drop clients that never completed sign-in within a day of registering.
      this.run('DELETE FROM clients WHERE expires<? AND id NOT IN (SELECT client FROM grants)', now() + 29 * 86400000);
      this.run('DELETE FROM subscriptions WHERE expires<? OR grant_id IN (SELECT id FROM grants WHERE revoked=1 OR expires<?)', now(), now());
      this.run('DELETE FROM messages WHERE created<?', now() - 7 * 86400000);
      this.run("UPDATE deliveries SET state='expired' WHERE state='pending' AND sub IN (SELECT id FROM subscriptions WHERE active=0)");
    });
  }
}
