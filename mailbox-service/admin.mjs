import { Store, token, hash, id } from './store.mjs';
import { openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { issueAgentCredential } from './agent-credential.mjs';
process.umask(0o077);
const store = new Store(process.env.DOT_DATA, process.env.DOT_SECRET);
try {
  const [command, value, destination] = process.argv.slice(2);
  if (command === 'create-owner') {
    if (!value || value.length > 80) throw new Error('Provide an account label of at most 80 characters.');
    const key = token(), owner = id();
    store.run('INSERT INTO owners(id,label,key_hash) VALUES(?,?,?)', owner, value, hash(key));
    const box = store.createBox(owner, 'My Dot');
    console.log(JSON.stringify({ owner_id: owner, account_key: key, mailbox_id: box }));
  } else if (command === 'create-mailbox') {
    if (!store.get('SELECT id FROM owners WHERE id=? AND disabled=0', value) || !destination || destination.length > 80) throw new Error('Provide an active owner ID and mailbox label.');
    console.log(JSON.stringify({ mailbox_id: store.createBox(value, destination) }));
  } else if (command === 'create-agent') {
    if (!destination) throw new Error('Provide a mailbox ID and a new private output file.');
    const fd = openSync(destination, 'wx', 0o600);
    let credential;
    try {
      credential = issueAgentCredential(store, value, process.env.DOT_ORIGIN);
      writeFileSync(fd, JSON.stringify(credential, null, 2) + '\n');
    } catch (error) {
      if (credential) store.revoke(credential.grant_id);
      closeSync(fd); unlinkSync(destination); throw error;
    }
    closeSync(fd);
    console.log(JSON.stringify({ mailbox_id: value, grant_id: credential.grant_id, expires_at: credential.expires_at, config_file: destination }));
  } else if (command === 'revoke-agent') {
    const grant = store.get('SELECT id FROM grants WHERE id=? AND client LIKE ?', value, 'agent_%');
    if (!grant) throw new Error('Unknown agent grant.');
    store.revoke(grant.id); console.log('Agent credential revoked.');
  } else if (command === 'disable-owner') {
    if (!/^[a-f0-9]{32}$/.test(value || '')) throw new Error('Provide the owner ID.');
    store.run('UPDATE owners SET disabled=1 WHERE id=?', value);
    for (const grant of store.all('SELECT id FROM grants WHERE owner=?', value)) store.revoke(grant.id);
    store.run('DELETE FROM sessions WHERE owner=?', value); console.log('Account disabled.');
  } else if (command === 'rotate-key') {
    if (!store.get('SELECT id FROM owners WHERE id=?', value)) throw new Error('Unknown owner.');
    const key = token(); store.run('UPDATE owners SET key_hash=? WHERE id=?', hash(key), value);
    store.run('DELETE FROM sessions WHERE owner=?', value);
    console.log(JSON.stringify({ owner_id: value, account_key: key }));
  } else if (command === 'status') {
    console.log(JSON.stringify({ owners: store.get('SELECT count(*) AS n FROM owners WHERE disabled=0').n, mailboxes: store.get('SELECT count(*) AS n FROM boxes').n, subscriptions: store.get('SELECT count(*) AS n FROM subscriptions WHERE active=1 AND expires>?', Date.now()).n, queue: store.all('SELECT state,count(*) AS count FROM deliveries GROUP BY state') }));
  } else throw new Error('Use create-owner LABEL, create-mailbox OWNER LABEL, create-agent MAILBOX FILE, revoke-agent GRANT, disable-owner ID, rotate-key ID, or status.');
} finally { store.db.close(); }
