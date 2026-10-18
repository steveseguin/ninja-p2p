import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';
import { timingSafeEqual } from 'node:crypto';
import { id, now, fail } from './store.mjs';

export function callbackURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || value.length > 2048) fail('invalid_callback');
  return url;
}
export function publicAddress(address) {
  try { const parsed = ipaddr.process(address); return parsed.range() === 'unicast'; } catch { return false; }
}
export async function webhookPost(destination, body, headers) {
  const url = callbackURL(destination);
  const addresses = await Promise.race([lookup(url.hostname, { all: true }), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('dns_timeout')), 3000); t.unref(); })]);
  if (!addresses.length || addresses.some(record => !publicAddress(record.address))) throw new Error('invalid_callback_address');
  // Pin the actual connection to a validated IP, retaining hostname/SNI and certificate verification.
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', agent: false, rejectUnauthorized: true, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      lookup: (_host, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family), timeout: 8000,
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16384) res.destroy(new Error('response_too_large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('webhook_timeout')), 10000);
    req.on('timeout', () => req.destroy(new Error('webhook_timeout')));
    req.on('error', reject); req.on('close', () => clearTimeout(deadline)); req.end(body);
  });
}
export function signed(secret, eventId, body, subscription) {
  const date = new Date();
  return { 'webhook-id': eventId, 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)), 'webhook-signature': new Webhook(secret).sign(eventId, date, body), 'X-MCP-Subscription-Id': subscription };
}
export async function verifyCallback(subscription, post = webhookPost) {
  const challenge = id(), body = JSON.stringify({ type: 'verification', challenge }), eventId = 'verification_' + id();
  const response = await post(subscription.url, body, signed(subscription.secret, eventId, body, subscription.id));
  let received; try { received = JSON.parse(response.text).challenge; } catch {}
  if (response.status < 200 || response.status >= 300 || typeof received !== 'string' || Buffer.byteLength(received) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(received), Buffer.from(challenge))) throw new Error('challenge_failed');
}
export function startDelivery(store, post = webhookPost) {
  let stopped = false, pausedUntil = 0;
  const active = new Set(), owners = new Set();
  const deliver = async row => {
        let status = 0;
        try {
          const subscription = store.open(row.sealed, 'subscription:' + row.box + ':' + row.sub);
          const message = store.get('SELECT * FROM messages WHERE id=? AND box=?', row.message, row.box);
          if (!message) return;
          const eventId = 'evt_' + store.identity(row.sub + ':' + row.message);
          const event = { eventId, name: 'message.created', timestamp: new Date(message.created).toISOString(), data: store.message(message), cursor: null };
          const body = JSON.stringify(event);
          const headers = signed(subscription.secret, eventId, body, row.sub);
          if (subscription.previousSecret && subscription.rotateUntil > now()) {
            const date = new Date(Number(headers['webhook-timestamp']) * 1000);
            headers['webhook-signature'] += ' ' + new Webhook(subscription.previousSecret).sign(eventId, date, body);
          }
          status = (await post(subscription.url, body, headers)).status;
        } catch { /* Retry without recording callback URLs, payloads or secrets in logs. */ }
        const attempts = row.attempts + 1;
        const state = status >= 200 && status < 300 ? 'delivered' : [410, 413].includes(status) || attempts >= 7 ? 'failed' : 'pending';
        store.run('UPDATE deliveries SET attempts=?,state=?,status=?,due=? WHERE sub=? AND message=?', attempts, state, status, now() + Math.min(3600000, 5000 * 4 ** (attempts - 1)), row.sub, row.message);
        if (status === 410) store.run('UPDATE subscriptions SET active=0 WHERE id=?', row.sub);
  };
  const pump = () => {
    if (stopped || now() < pausedUntil) return;
    try {
      // At most four asynchronous HTTPS requests and one per account. A slow
      // recipient cannot hold the other accounts' worker slots or message bodies.
      while (active.size < 4) {
        const excluded = Array.from(owners);
        const condition = excluded.length ? ` AND o.id NOT IN (${excluded.map(() => '?').join(',')})` : '';
        const row = store.get(`SELECT d.*,s.sealed,s.box,s.expires,s.active,s.grant_id,o.id AS owner FROM deliveries d JOIN subscriptions s ON s.id=d.sub JOIN grants g ON g.id=s.grant_id JOIN owners o ON o.id=g.owner WHERE d.state='pending' AND d.due<=? AND s.active=1 AND s.expires>? AND g.expires>? AND g.revoked=0 AND o.disabled=0${condition} ORDER BY d.due LIMIT 1`, now(), now(), now(), ...excluded);
        if (!row) break;
        owners.add(row.owner);
        const job = deliver(row).catch(() => { pausedUntil = now() + 5000; console.error('Delivery worker error'); }).finally(() => { active.delete(job); owners.delete(row.owner); if (!stopped) setImmediate(pump); });
        active.add(job);
      }
    } catch { console.error('Delivery queue error'); }
  };
  const tick = async () => { pump(); while (active.size) { await Promise.all(Array.from(active)); pump(); } };
  const interval = setInterval(pump, 1000); interval.unref();
  return { tick, async stop() { stopped = true; clearInterval(interval); await Promise.all(Array.from(active)); } };
}
