import { hash, id, now, token, fail } from './store.mjs';

// One revocable mailbox grant, never an account key or a room-wide credential.
export function issueAgentCredential(store, mailbox, origin, inTransaction = false) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))) fail('invalid_origin');
  const box = store.get('SELECT b.* FROM boxes b JOIN owners o ON o.id=b.owner WHERE b.id=? AND o.disabled=0', mailbox) || fail('unknown_mailbox');
  const grantId = id(), clientId = 'agent_' + id(), access = token(), expires = now() + 30 * 86400000;
  const issue = () => {
    if (store.get('SELECT count(*) AS n FROM grants WHERE owner=? AND revoked=0 AND expires>?', box.owner, now()).n >= 30) fail('connection_limit');
    store.run('INSERT INTO clients VALUES(?,?,?)', clientId, JSON.stringify({ client_name: 'Ninja P2P cloud agent', kind: 'agent' }), expires);
    store.run('INSERT INTO grants VALUES(?,?,?,?,?,0)', grantId, box.owner, mailbox, clientId, expires);
    store.run('INSERT INTO credentials VALUES(?,?,?,?,0,NULL)', hash(access), grantId, 'access', expires);
  };
  if (inTransaction) issue(); else store.transaction(issue);
  return { url: origin, token: access, mailbox_id: mailbox, grant_id: grantId, expires_at: new Date(expires).toISOString() };
}
