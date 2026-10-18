// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT

'use strict';
// Adapted from Ninja MCP's HTTP relay transport; uses the same opaque-event relay API.
// A separate room/key namespace keeps its application protocol isolated.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const EventEmitter = require('node:events');

function validateRelayConfig(config) {
  let url;
  try { url = new URL(config.relayUrl); } catch (_) { throw new Error('relay_url must be a valid HTTPS origin'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('relay_url requires HTTPS except on loopback');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('relay_url must be an origin without credentials, path, query, or fragment');
  }
  if (typeof config.relayToken !== 'string' || config.relayToken.length < 32 || /[^\x21-\x7e]/.test(config.relayToken)) {
    throw new Error('relay_token requires at least 32 printable non-space characters');
  }
  if (typeof config.relayKey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(config.relayKey)) {
    throw new Error('relay_key requires 32 random bytes encoded as 64 hexadecimal characters');
  }
  return url;
}

// Implements the bridge's small SDK event/send interface without loading WebRTC.
// POST acceptance is a relay receipt, not confirmation that a peer consumed data.
class HttpRelayTransport extends EventEmitter {
  constructor(config) {
    super();
    const origin = validateRelayConfig(config);
    const secret = Buffer.from(config.relayKey, 'hex');
    this.roomId = crypto.createHmac('sha256', secret).update(`ninja-p2p-room-v1:${config.room}`).digest('hex');
    this.key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(this.roomId), Buffer.from('ninja-p2p-relay-v1'), 32));
    this.url = new URL(`/v1/rooms/${this.roomId}/events`, origin);
    this.token = config.relayToken;
    this.uuid = crypto.randomUUID();
    this.streamID = null;
    this.connected = false;
    this.closed = false;
    this.cursor = null;
    this.peers = new Map();
    this.seen = new Map();
    this.requests = new Set();
    this.pending = [];
    this.pendingBytes = 0;
    this.sending = false;
    this.heartbeat = null;
    this.retryTimer = null;
    this.retryResolve = null;
  }

  addEventListener(name, handler) { this.on(name, handler); }
  removeEventListener(name, handler) { this.off(name, handler); }
  event(name, detail) { this.emit(name, { detail }); }

  request(method, search, body) {
    if (this.closed) return Promise.reject(new Error('relay transport stopped'));
    const url = new URL(this.url);
    url.search = search || '';
    const encoded = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${this.token}` };
      if (encoded) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(encoded);
      }
      const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { res.destroy(new Error('relay response too large')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
            reject(new Error('invalid relay response')); return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else {
            const error = new Error(`relay HTTP ${res.statusCode}`);
            error.status = res.statusCode;
            error.response = data;
            reject(error);
          }
        });
      });
      this.requests.add(req);
      req.once('close', () => this.requests.delete(req));
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('relay request timed out')));
      req.end(encoded);
    });
  }

  seal(kind, data, target) {
    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${this.roomId}:${id}`));
    const plaintext = JSON.stringify({ v: 1, from: this.uuid, stream: this.streamID, ts: Date.now(), kind, target: target || null, data });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { id, box: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64') };
  }

  open(event) {
    if (!event || typeof event.id !== 'string' || typeof event.box !== 'string') throw new Error('invalid relay event');
    const box = Buffer.from(event.box, 'base64');
    if (box.length < 29 || box.length > 768 * 1024) throw new Error('invalid relay ciphertext');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, box.subarray(0, 12));
    decipher.setAuthTag(box.subarray(12, 28));
    decipher.setAAD(Buffer.from(`${this.roomId}:${event.id}`));
    const data = JSON.parse(Buffer.concat([decipher.update(box.subarray(28)), decipher.final()]).toString('utf8'));
    if (data.v !== 1 || typeof data.from !== 'string' || !/^[a-f0-9-]{36}$/.test(data.from) ||
        typeof data.stream !== 'string' || data.stream.length > 256 || !Number.isFinite(data.ts) ||
        data.ts < Date.now() - 300000 || data.ts > Date.now() + 60000 ||
        !['hello', 'data', 'binary'].includes(data.kind) ||
        (data.target !== null && typeof data.target !== 'string')) throw new Error('invalid relay message');
    return data;
  }

  async connect() {
    const result = await this.request('GET');
    if (this.closed) return;
    if (!result || typeof result.cursor !== 'string') throw new Error('invalid relay cursor');
    this.cursor = result.cursor;
    this.connected = true;
    this.event('connected', { transport: 'http' });
  }

  get state() { return { uuid: this.uuid }; }
  async joinRoom() {}
  leaveRoom() {}
  stopViewing() {}
  async publish() { throw new Error('HTTP relay does not carry live media; use WebRTC'); }
  stopPublishing() {}
  async getStats() { return { transport: 'http', connected: this.connected, queued: this.pending.length }; }

  async announce(options) {
    if (typeof options.streamID !== 'string' || !options.streamID || options.streamID.length > 256) {
      throw new Error('HTTP stream_id requires 1 to 256 characters');
    }
    this.streamID = options.streamID;
    await this.request('POST', '', this.seal('hello', { request_reply: true }));
    if (this.closed) return;
    this.heartbeat = setInterval(() => {
      if (this.connected) this.enqueue(this.seal('hello', null));
      for (const [uuid, peer] of this.peers) {
        if (Date.now() - peer.seen > 45000) {
          this.peers.delete(uuid);
          this.event('peerDisconnected', { uuid, streamID: peer.streamID });
        }
      }
    }, 10000);
    this.readLoop().catch(() => { if (!this.closed) this.event('error', { error: 'relay reader stopped' }); });
  }

  // Every holder of the room key participates. A target selects delivery; it is
  // not an authorization boundary between members of this trusted group.
  async view() {}

  hasOpenDataChannel(uuid) { return this.connected && (uuid ? this.peers.has(uuid) : this.peers.size > 0); }
  sendPing() { return this.connected; }

  sendData(data, target) {
    const uuid = typeof target === 'string' ? target : target && target.uuid;
    if (!this.hasOpenDataChannel(uuid)) return false;
    if (target && typeof target === 'object' && !uuid) return false;
    const binary = Buffer.isBuffer(data) || data instanceof ArrayBuffer;
    const event = this.seal(binary ? 'binary' : 'data', binary ? Buffer.from(data).toString('base64') : data, uuid);
    const envelope = data && data.v === 1 && data.id ? data : null;
    const ok = this.enqueue(event, envelope ? { message_id: envelope.id, type: envelope.type } : null);
    this.lastMessageId = ok ? event.id : null;
    return ok;
  }

  enqueue(event, receipt = false) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.closed || bytes > 768 * 1024 || this.pending.length >= 128 || this.pendingBytes + bytes > 8 * 1024 * 1024) return false;
    this.pending.push({ event, bytes, receipt });
    this.pendingBytes += bytes;
    this.flush().catch(() => { if (!this.closed) this.event('error', { error: 'relay sender stopped' }); });
    return true;
  }

  async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (!this.closed && this.pending.length) {
        const item = this.pending[0];
        let accepted = false;
        for (let attempt = 0; attempt < 3 && !this.closed; attempt += 1) {
          try {
            const result = await this.request('POST', '', item.event);
            if (!result || result.accepted !== true) throw new Error('invalid relay receipt');
            accepted = true;
            break;
          } catch (error) {
            if (error.status && error.status < 500) break;
          }
        }
        if (this.closed) break;
        this.pending.shift();
        this.pendingBytes -= item.bytes;
        if (item.receipt) this.event('relayReceipt', { ...item.receipt, transport_id: item.event.id, stage: accepted ? 'relay_accepted' : 'delivery_unknown' });
        if (!accepted) this.event('error', { error: 'relay send failed; delivery unknown', message_id: item.event.id });
      }
    } finally { this.sending = false; }
  }

  receive(event) {
    if (this.seen.has(event.id)) return;
    let message;
    try { message = this.open(event); } catch (_) {
      this.event('relayRejected', { reason: 'invalid_encrypted_message' });
      return;
    }
    this.seen.set(event.id, Date.now());
    while (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
    if (message.from === this.uuid) return;
    let peer = this.peers.get(message.from);
    if (peer && peer.streamID !== message.stream) return;
    if (!peer) {
      if (message.kind !== 'hello' || this.peers.size >= 128) return;
      peer = { streamID: message.stream, seen: Date.now() };
      this.peers.set(message.from, peer);
      // Reply once to discovery; repeated heartbeats do not create a reply loop.
      this.enqueue(this.seal('hello', null));
      this.event('peerConnected', { uuid: message.from, streamID: message.stream });
      this.event('dataChannelOpen', { uuid: message.from, streamID: message.stream, transport: 'http' });
    } else if (message.kind === 'hello' && message.data && message.data.request_reply === true) {
      this.enqueue(this.seal('hello', null));
    }
    peer.seen = Date.now();
    if (message.target && message.target !== this.uuid) return;
    if (message.kind === 'data' || (message.kind === 'binary' && typeof message.data === 'string')) {
      this.event('dataReceived', {
        uuid: message.from, streamID: message.stream, fallback: true, message_id: event.id,
        data: message.kind === 'binary' ? Buffer.from(message.data, 'base64') : message.data
      });
    }
  }

  async readLoop() {
    let failures = 0;
    while (!this.closed) {
      try {
        const result = await this.request('GET', `?after=${encodeURIComponent(this.cursor)}&wait_ms=25000`);
        if (this.closed) return;
        if (!result || typeof result.cursor !== 'string' || !Array.isArray(result.events)) throw new Error('invalid relay events');
        if (!this.connected) this.event('relayConnection', { connected: true });
        this.connected = true;
        if (failures) this.enqueue(this.seal('hello', { request_reply: true }));
        failures = 0;
        for (const event of result.events) this.receive(event);
        this.cursor = result.cursor;
      } catch (error) {
        if (this.closed) return;
        if (this.connected) this.event('relayConnection', { connected: false });
        this.connected = false;
        failures += 1;
        const response = error.response;
        if (error.status === 409 && response && response.error === 'relay_history_lost' && typeof response.cursor === 'string') {
          this.cursor = response.cursor;
          for (const uuid of this.peers.keys()) this.event('peerDisconnected', { uuid });
          this.peers.clear();
          this.event('relayGap', { reason: 'relay_history_lost' });
          this.enqueue(this.seal('hello', { request_reply: true }));
        } else if (failures === 1) this.event('error', { error: error.message });
        await new Promise((resolve) => {
          this.retryResolve = resolve;
          this.retryTimer = setTimeout(resolve, Math.min(1000 * failures, 10000));
        });
        this.retryResolve = null;
        this.retryTimer = null;
      }
    }
  }

  disconnect() {
    this.closed = true;
    this.connected = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    if (this.retryResolve) this.retryResolve();
    for (const req of this.requests) req.destroy(new Error('relay transport stopped'));
    this.pending = [];
    this.pendingBytes = 0;
    this.peers.clear();
  }
}

module.exports = { HttpRelayTransport, validateRelayConfig };
