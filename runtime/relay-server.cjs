#!/usr/bin/env node
// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 768 * 1024;
const RETENTION_MS = 5 * 60 * 1000;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// One relay instance serves a trusted group. The bearer token grants relay access;
// room encryption keys stay on the clients and are never sent to this server.
async function startRelayServer(options = {}) {
  const token = options.token || process.env.VDON_RELAY_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || /[^\x21-\x7e]/.test(token)) {
    throw new Error('VDON_RELAY_TOKEN requires at least 32 printable non-space characters');
  }
  const expectedAuth = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  const rooms = new Map();
  const responses = new Set();
  const sockets = new Set();
  let closing = false;
  let closePromise;

  function prune(room) {
    const cutoff = Date.now() - RETENTION_MS;
    while (room.events.length && (room.events.length > 512 || room.bytes > 8 * 1024 * 1024 || room.events[0].ts < cutoff)) {
      const removed = room.events.shift();
      room.bytes -= removed.bytes;
      room.ids.delete(removed.id);
    }
  }

  function readEvents(room, cursor) {
    prune(room);
    const latest = `${room.epoch}:${room.seq}`;
    if (cursor === null) return { cursor: latest, events: [] };
    const match = /^([a-f0-9-]{36}):(\d+)$/.exec(cursor);
    const seq = match ? Number(match[2]) : NaN;
    const oldest = room.events.length ? room.events[0].seq : room.seq + 1;
    if (!match || match[1] !== room.epoch || !Number.isSafeInteger(seq) || seq < oldest - 1 || seq > room.seq) {
      return { error: 'relay_history_lost', cursor: latest, events: [] };
    }
    const events = [];
    let bytes = 0;
    for (const event of room.events) {
      if (event.seq <= seq) continue;
      if (events.length && bytes + event.bytes > 1024 * 1024) break;
      bytes += event.bytes;
      events.push({ id: event.id, box: event.box });
    }
    return { cursor: `${room.epoch}:${seq + events.length}`, events };
  }

  async function handle(req, res) {
    if (closing) return json(res, 503, { error: 'relay_closing' });
    const auth = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
    if (!crypto.timingSafeEqual(auth, expectedAuth)) return json(res, 401, { error: 'unauthorized' });
    let url;
    try { url = new URL(req.url, 'http://relay.local'); } catch (_) {
      return json(res, 400, { error: 'invalid_url' });
    }
    const match = /^\/v1\/rooms\/([a-f0-9]{64})\/events$/.exec(url.pathname);
    if (!match) return json(res, 404, { error: 'not_found' });
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'method_not_allowed' });
    let room = rooms.get(match[1]);
    if (!room) {
      if (rooms.size >= 16) return json(res, 503, { error: 'relay_room_limit' });
      room = { epoch: crypto.randomUUID(), seq: 0, events: [], ids: new Map(), bytes: 0, waiters: new Set(), touched: Date.now() };
      rooms.set(match[1], room);
    }
    room.touched = Date.now();
    if (req.method === 'GET') {
      const cursor = url.searchParams.get('after');
      const result = readEvents(room, cursor);
      const wait = Math.min(25000, Math.max(0, Number(url.searchParams.get('wait_ms')) || 0));
      if (result.error || result.events.length || cursor === null || !wait) {
        return json(res, result.error ? 409 : 200, result);
      }
      if (room.waiters.size >= 32 || responses.size >= 128) return json(res, 429, { error: 'relay_reader_limit' });
      const finish = () => {
        cleanup();
        const next = readEvents(room, cursor);
        json(res, next.error ? 409 : 200, next);
      };
      const cleanup = () => {
        clearTimeout(timer);
        room.waiters.delete(finish);
        responses.delete(res);
        res.removeListener('close', cleanup);
      };
      const timer = setTimeout(finish, wait);
      room.waiters.add(finish);
      responses.add(res);
      res.on('close', cleanup);
      return;
    }

    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 415, { error: 'json_required' });
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        json(res, 413, { error: 'event_too_large' });
        return;
      }
      chunks.push(chunk);
    }
    let event;
    try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
      return json(res, 400, { error: 'invalid_json' });
    }
    if (!event || typeof event.id !== 'string' || !/^[a-f0-9-]{36}$/.test(event.id) ||
        typeof event.box !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.box) || event.box.length < 40) {
      return json(res, 400, { error: 'invalid_event' });
    }
    prune(room);
    const previous = room.ids.get(event.id);
    if (previous) {
      if (previous.box !== event.box) return json(res, 409, { error: 'event_id_conflict' });
      return json(res, 200, { accepted: true, duplicate: true });
    }
    const stored = { id: event.id, box: event.box, seq: ++room.seq, ts: Date.now(), bytes };
    room.events.push(stored);
    room.ids.set(stored.id, stored);
    room.bytes += bytes;
    prune(room);
    json(res, 202, { accepted: true });
    for (const finish of Array.from(room.waiters)) finish();
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'invalid_request' });
      else res.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 256;
  const cleanup = setInterval(() => {
    for (const [name, room] of rooms) {
      prune(room);
      if (!room.waiters.size && Date.now() - room.touched > RETENTION_MS) rooms.delete(name);
    }
  }, 30000);
  cleanup.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port === undefined ? 8790 : options.port, options.host || '127.0.0.1', resolve);
    });
  } catch (error) {
    clearInterval(cleanup);
    throw error;
  }
  return {
    server,
    port: server.address().port,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(cleanup);
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const res of responses) res.destroy();
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    }
  };
}

if (require.main === module) {
  if (process.argv.includes('--help')) {
    console.log('Usage: ninja-p2p-relay\nEnvironment: VDON_RELAY_TOKEN (required), VDON_RELAY_HOST (127.0.0.1), VDON_RELAY_PORT (8790).\nUse an HTTPS reverse proxy for remote clients. See docs/cloud-connections.md.');
  } else {
    const port = Number(process.env.VDON_RELAY_PORT || 8790);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('VDON_RELAY_PORT must be between 1 and 65535');
      process.exitCode = 1;
    } else {
      startRelayServer({ host: process.env.VDON_RELAY_HOST, port }).then((relay) => {
        console.error(`Ninja relay listening on port ${relay.port}`);
        const stop = () => relay.close().catch(() => { process.exitCode = 1; });
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      }).catch((error) => { console.error(error.message); process.exitCode = 1; });
    }
  }
}

module.exports = { startRelayServer };
