import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createDemoServer } from '../demo-server';
import { fixture, handles, comment, suggestion } from './fixture';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Timed out'); await setTimeout(15); }
}

test('real WS clients obey per-user policy, reject mixed/reconnect writes, and preserve accepted state', { timeout: 40000 }, async () => {
  const server = createDemoServer(0); await server.listen();
  const room = 'sd2/v2.1/integration'; const api = `${server.httpURL}/api/rooms/integration`;
  const resources: Array<{ doc: Y.Doc; provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket }> = [];
  let closeCode = 0;
  const connect = async (doc: Y.Doc, user: string) => {
    const socket = new HocuspocusProviderWebsocket({ url: server.webSocketURL, WebSocketPolyfill: WebSocket,
      onClose: ({ event }) => { if (event.code === 4403) { socket.shouldConnect = false; closeCode = event.code; } },
    });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: doc, token: user, broadcast: false });
    resources.push({ doc, socket, provider }); await until(() => provider.synced || closeCode === 4403); return provider;
  };
  const policy = async (permissions: Record<string, boolean>, user = 'writer') => {
    const response = await fetch(`${api}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, permissions }) }); assert.equal(response.status, 200);
  };
  const fresh = () => { const d = new Y.Doc({ gc: false }); d.getMap('content'); Y.applyUpdate(d, Y.encodeStateAsUpdate(server.documents.get(room)!)); return d; };
  try {
    const writer = fixture(); await connect(writer, 'writer');
    await until(() => !!server.documents.get(room)?.getMap('content').get('story'));
    const observer = new Y.Doc(); observer.getMap('content'); await connect(observer, 'observer');
    await policy({ comment: true, suggestion: true, edit: false });
    handles(writer).text.insert(0, 'DENIED '); await until(() => closeCode === 4403);
    assert.equal(handles(server.documents.get(room)!).text.toString(), 'Original document.'); assert.equal(handles(observer).text.toString(), 'Original document.');
    const restored = fresh(); closeCode = 0; await connect(restored, 'writer'); comment(restored);
    await until(() => handles(server.documents.get(room)!).comments.has('c1'));
    suggestion(restored); await until(() => handles(server.documents.get(room)!).text.toString().includes('proposed'));
    await policy({ comment: false, suggestion: false, edit: false });
    handles(restored).comments.get('c1').set('bodyText', 'DENIED COMMENT'); await until(() => closeCode === 4403);
    assert.equal(handles(server.documents.get(room)!).comments.get('c1').get('bodyText'), 'Review this');
    // Offline/direct state must be checked in SyncStep2 on reconnect as well.
    const offline = fresh(); handles(offline).text.insert(0, 'DENIED OFFLINE '); closeCode = 0; await connect(offline, 'writer'); await until(() => closeCode === 4403);
    assert.ok(!handles(server.documents.get(room)!).text.toString().includes('DENIED'));
    // A different user's policy is independent and can still allow writes.
    handles(observer).text.insert(0, 'OBSERVER '); await until(() => handles(server.documents.get(room)!).text.toString().startsWith('OBSERVER '));
    const events = (await (await fetch(api)).json()).events;
    for (const type of ['comment', 'suggestion', 'edit']) assert.ok(events.some((e: any) => e.type === type), `Missing ${type} decisions`);
    assert.ok(events.some((e: any) => e.type === 'comment' && !e.allowed));
    // Invalid API requests do not silently change a policy.
    const invalid = await fetch(`${api}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'writer', permissions: { comment: 'yes' } }) }); assert.equal(invalid.status, 400);
  } finally {
    for (const { provider, socket, doc } of resources) { provider.destroy(); socket.destroy(); doc.destroy(); }
    await server.destroy();
  }
});
