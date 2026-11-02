import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { classifySnapshots } from './semantics.js';

export type OperationType = 'comment' | 'suggestion' | 'edit';
export type Permissions = Record<OperationType, boolean>;
export type Inspection = {
  type: OperationType;
  changed: boolean;
  reason: string;
  milliseconds: number;
  paths: string[];
};

export function snapshot(value: any): any {
  if (value instanceof Y.Text) return { $text: value.toDelta() };
  if (value instanceof Y.Map) return Object.fromEntries([...value].map(([key, child]) => [key, snapshot(child)]));
  if (value instanceof Y.Array) return value.toArray().map(snapshot);
  if (value instanceof Y.AbstractType) return { $other: value.toJSON() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshot(child)]));
  return value;
}

export function snapshotDoc(document: Y.Doc): any {
  for (const name of document.share.keys()) document.getMap(name);
  return snapshot(Object.fromEntries(document.share));
}

export function changedPaths(before: any, after: any, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [path];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap(key => changedPaths(before[key], after[key], `${path}/${key}`));
}

/** Extract the update from Hocuspocus 2.x framing; control messages return null. */
export function decodeMessage(frame: Uint8Array): { documentName: string; update: Uint8Array } | null {
  const decoder = decoding.createDecoder(frame);
  const documentName = decoding.readVarString(decoder);
  const type = decoding.readVarUint(decoder);
  if (type !== 0 && type !== 4) return null;
  const subtype = decoding.readVarUint(decoder);
  if (subtype === 0) return null;
  if (subtype !== 1 && subtype !== 2) throw new Error('Unsupported sync message');
  const update = decoding.readVarUint8Array(decoder);
  if (decoding.hasContent(decoder)) throw new Error('Trailing protocol data');
  return { documentName, update };
}

/** Inspect in an isolated copy. Never apply an unapproved update to the live room. */
export function classifyUpdate(document: Y.Doc, update: Uint8Array): Inspection {
  const start = performance.now();
  if (update.byteLength > 2 * 1024 * 1024) throw new Error('Update exceeds demo limit');
  const candidate = new Y.Doc({ gc: false });
  try {
    for (const name of document.share.keys()) candidate.getMap(name);
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    const before = snapshotDoc(candidate);
    Y.applyUpdate(candidate, update);
    if (candidate.store.pendingStructs || candidate.store.pendingDs) throw new Error('Unresolved CRDT dependencies');
    const after = snapshotDoc(candidate);
    const paths = changedPaths(before, after);
    const classification = classifySnapshots(before, after);
    return { ...classification, changed: paths.length > 0, paths, milliseconds: performance.now() - start };
  } finally {
    candidate.destroy();
  }
}

export function isAllowed(inspection: Inspection, permissions: Permissions): boolean {
  return !inspection.changed || permissions[inspection.type];
}
