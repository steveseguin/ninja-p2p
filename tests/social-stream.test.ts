import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildSocialStreamUrl,
  describeSocialMessage,
  normalizeSocialMessage,
  SocialStreamBridge,
  type SocialMessage,
  type SocialSocket,
} from "../src/social-stream.js";

test("buildSocialStreamUrl joins the chat channel and the command channel", () => {
  assert.equal(
    buildSocialStreamUrl("abc123"),
    "wss://io.socialstream.ninja/join/abc123/4/1",
  );
});

test("buildSocialStreamUrl trims a trailing slash and encodes the session", () => {
  assert.equal(
    buildSocialStreamUrl("a b/c", "wss://example.test/", 2, 3),
    "wss://example.test/join/a%20b%2Fc/2/3",
  );
});

test("normalizeSocialMessage flattens a chat payload", () => {
  const message = normalizeSocialMessage({
    chatname: "Viewer1",
    chatmessage: "hello there",
    type: "Twitch",
    chatimg: "https://example.test/a.png",
    id: 42,
    moderator: true,
  });

  assert.ok(message);
  assert.equal(message.author, "Viewer1");
  assert.equal(message.text, "hello there");
  assert.equal(message.platform, "twitch");
  assert.equal(message.avatar, "https://example.test/a.png");
  assert.equal(message.id, "42");
  assert.equal(message.moderator, true);
  assert.equal(message.bot, false);
});

test("normalizeSocialMessage strips emote markup but keeps textonly intact", () => {
  const withMarkup = normalizeSocialMessage({
    chatname: "Viewer",
    chatmessage: 'nice <img src="emote.png"> play&amp;fun',
    type: "youtube",
  });
  assert.equal(withMarkup?.text, "nice play&fun");

  const plain = normalizeSocialMessage({
    chatname: "Viewer",
    chatmessage: "keep <this> exact",
    textonly: true,
    type: "youtube",
  });
  assert.equal(plain?.text, "keep <this> exact");
});

test("normalizeSocialMessage carries donations, events, and membership", () => {
  const message = normalizeSocialMessage({
    chatname: "Fan",
    chatmessage: "take my money",
    type: "kick",
    hasDonation: "$50.00 USD",
    membership: "Tier 3",
    event: "raid",
    sourceName: "somechannel",
  });

  assert.equal(message?.donation, "$50.00 USD");
  assert.equal(message?.membership, "Tier 3");
  assert.equal(message?.event, "raid");
  assert.equal(message?.sourceName, "somechannel");
});

test("normalizeSocialMessage ignores control traffic", () => {
  // The channel also carries callbacks, queue sizes, and waitlist state. None
  // of that should reach an agent.
  assert.equal(normalizeSocialMessage({ callback: { get: "x", result: true } }), null);
  assert.equal(normalizeSocialMessage({ action: "nextInQueue" }), null);
  assert.equal(normalizeSocialMessage({ waitlist: [] }), null);
  assert.equal(normalizeSocialMessage({ chatname: "   " }), null);
  assert.equal(normalizeSocialMessage(null), null);
  assert.equal(normalizeSocialMessage("nope"), null);
});

test("describeSocialMessage renders a readable one-liner", () => {
  const base: SocialMessage = {
    id: "1",
    platform: "twitch",
    author: "Fan",
    text: "hi",
    avatar: null,
    donation: null,
    membership: null,
    event: null,
    sourceName: null,
    moderator: false,
    bot: false,
  };

  assert.equal(describeSocialMessage(base), "[twitch] Fan: hi");
  assert.equal(
    describeSocialMessage({ ...base, donation: "$5", event: "raid" }),
    "[twitch] Fan ($5) <raid>: hi",
  );
});

type FakeSocket = SocialSocket & {
  sent: string[];
  fireOpen: () => void;
  fireMessage: (payload: unknown) => void;
  fireClose: () => void;
  closed: boolean;
};

function makeFakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string): SocialSocket => {
    const socket: FakeSocket = {
      sent: [],
      closed: false,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string) { socket.sent.push(data); },
      close() { socket.closed = true; },
      fireOpen: () => socket.onopen?.(),
      fireMessage: (payload: unknown) => socket.onmessage?.({ data: JSON.stringify(payload) }),
      fireClose: () => socket.onclose?.(),
    };
    void url;
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

test("SocialStreamBridge forwards chat and ignores control traffic", () => {
  const { sockets, factory } = makeFakeSocketFactory();
  const received: SocialMessage[] = [];
  const bridge = new SocialStreamBridge({
    session: "abc",
    socketFactory: factory,
    onMessage: (message) => received.push(message),
  });

  bridge.connect();
  sockets[0].fireOpen();
  assert.equal(bridge.isConnected(), true);

  sockets[0].fireMessage({ chatname: "Viewer", chatmessage: "hello", type: "twitch" });
  sockets[0].fireMessage({ action: "nextInQueue" });
  sockets[0].fireMessage({ callback: { get: "a", result: true } });

  assert.equal(received.length, 1);
  assert.equal(received[0].author, "Viewer");
  bridge.close();
});

test("SocialStreamBridge survives malformed frames", () => {
  const { sockets, factory } = makeFakeSocketFactory();
  const received: SocialMessage[] = [];
  const bridge = new SocialStreamBridge({
    session: "abc",
    socketFactory: factory,
    onMessage: (message) => received.push(message),
  });

  bridge.connect();
  sockets[0].fireOpen();
  sockets[0].onmessage?.({ data: "not json at all" });
  sockets[0].fireMessage({ chatname: "Viewer", chatmessage: "still works", type: "twitch" });

  assert.equal(received.length, 1);
  bridge.close();
});

test("SocialStreamBridge reports whether an outbound chat actually went out", () => {
  const { sockets, factory } = makeFakeSocketFactory();
  const bridge = new SocialStreamBridge({
    session: "abc",
    socketFactory: factory,
    onMessage: () => {},
  });

  // Before the socket opens there is nowhere to send, and callers need to know.
  assert.equal(bridge.sendChat("too early"), false);

  bridge.connect();
  sockets[0].fireOpen();
  assert.equal(bridge.sendChat("hello chat"), true);
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { action: "sendChat", value: "hello chat" });
  bridge.close();
});

test("SocialStreamBridge reconnects after an unexpected close", async () => {
  const { sockets, factory } = makeFakeSocketFactory();
  const bridge = new SocialStreamBridge({
    session: "abc",
    socketFactory: factory,
    onMessage: () => {},
    backoffMs: [5],
  });

  bridge.connect();
  sockets[0].fireOpen();
  sockets[0].fireClose();
  assert.equal(bridge.isConnected(), false);

  await delay(40);
  assert.equal(sockets.length, 2, "should have opened a fresh socket");
  bridge.close();
});

test("SocialStreamBridge stops reconnecting once closed", async () => {
  const { sockets, factory } = makeFakeSocketFactory();
  const bridge = new SocialStreamBridge({
    session: "abc",
    socketFactory: factory,
    onMessage: () => {},
    backoffMs: [5],
  });

  bridge.connect();
  sockets[0].fireOpen();
  bridge.close();
  sockets[0].fireClose();

  await delay(40);
  assert.equal(sockets.length, 1, "close() must win over reconnect");
});

test("SocialStreamBridge requires a session id", () => {
  assert.throws(
    () => new SocialStreamBridge({ session: "  ", onMessage: () => {} }),
    /requires a session id/,
  );
});
