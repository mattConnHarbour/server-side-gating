import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { classifyUpdate, decodeMessage, isAllowed } from '../validator/index';

import { fixture, handles, propose, comment, suggestion } from './fixture';

test('classifies real schema effects, not a claimed operation label', () => {
  const doc = fixture(); const original = Y.encodeStateAsUpdate(doc);
  for (const [expected, change] of [
    ['comment', comment], ['suggestion', suggestion],
    ['edit', (d: Y.Doc) => handles(d).text.insert(0, 'Direct ')],
    ['edit', (d: Y.Doc) => { comment(d); handles(d).text.insert(0, 'Hidden direct edit '); }],
    ['edit', (d: Y.Doc) => { suggestion(d); handles(d).text.insert(0, 'Hidden direct edit '); }],
    ['edit', (d: Y.Doc) => { comment(d); suggestion(d); }],
    ['edit', (d: Y.Doc) => handles(d).text.format(0, 3, { bold: true })],
    ['edit', (d: Y.Doc) => d.getMap('unknown').set('payload', 'unexpected')],
  ] as const) {
    const result = classifyUpdate(doc, propose(doc, change));
    assert.equal(result.type, expected); assert.equal(result.changed, true);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), original, 'Inspection must not modify authoritative state');
  }
  doc.destroy();
});

test('forged insertComment journal cannot conceal a body edit', () => {
  const doc = fixture();
  const result = classifyUpdate(doc, propose(doc, d => {
    comment(d); handles(d).text.delete(0, 4);
    d.getMap('operations').set('spoof', new Y.Map<any>([['kind', 'insertComment'], ['opId', 'spoof'], ['status', 'committed']]));
  }));
  assert.equal(result.type, 'edit'); assert.equal(isAllowed(result, { comment: true, suggestion: true, edit: false }), false); doc.destroy();
});

test('unmatched and opaque revision wrappers fall back to edit', () => {
  for (const variant of ['missing-end', 'unsupported-deletion']) {
    const doc = fixture(); const result = classifyUpdate(doc, propose(doc, d => {
      suggestion(d); const atoms = handles(d).block.get('atoms');
      if (variant === 'missing-end') atoms.delete(1, 1); else atoms.get(0).set('meta', { wrapper: 'del', position: 'start', rsid: 'r1' });
    })); assert.equal(result.type, 'edit'); doc.destroy();
  }
});

test('no-op sync is allowed with all permissions disabled; malformed and pending updates are rejected', () => {
  const doc = fixture();
  const result = classifyUpdate(doc, Y.encodeStateAsUpdate(doc)); assert.equal(result.changed, false);
  assert.equal(isAllowed(result, { comment: false, suggestion: false, edit: false }), true);
  assert.throws(() => classifyUpdate(doc, new Uint8Array()));
  const offline = new Y.Doc(); offline.getMap('content').set('a', 'missing-first-update');
  let onlySecond: Uint8Array = new Uint8Array(); offline.on('update', u => { onlySecond = u; }); offline.getMap('content').set('b', 'requires-first');
  assert.throws(() => classifyUpdate(doc, onlySecond), /Unresolved/); offline.destroy(); doc.destroy();
});

test('Hocuspocus decoder distinguishes control frames and update frames', () => {
  const frame = (subtype: number, bytes = new Uint8Array([0, 0])) => {
    const e = encoding.createEncoder(); encoding.writeVarString(e, 'sd2/v2.1/test'); encoding.writeVarUint(e, 0); encoding.writeVarUint(e, subtype); encoding.writeVarUint8Array(e, bytes); return encoding.toUint8Array(e);
  };
  assert.equal(decodeMessage(frame(0)), null);
  assert.deepEqual(decodeMessage(frame(2)), { documentName: 'sd2/v2.1/test', update: new Uint8Array([0, 0]) });
  assert.throws(() => decodeMessage(new Uint8Array())); assert.throws(() => decodeMessage(frame(9)));
  assert.throws(() => decodeMessage(Uint8Array.from([...frame(2), 0])), /Trailing/);
});
