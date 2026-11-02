import { isDeepStrictEqual as equal } from 'node:util';
import type { OperationType } from './index.js';
type State = Record<string, any>;
const clone = (v: any) => structuredClone(v);
const commentParts = new Set(['/word/comments.xml', '/word/commentsExtended.xml', '/word/commentsIds.xml']);
const commentTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml', 'application/vnd.ms-word.commentsExtended+xml', 'application/vnd.ms-word.commentsIds+xml']);
const textOf = (block: any) => (block.text?.$text ?? []).map((run: any) => typeof run.insert === 'string' ? run.insert : '\ufffc').join('');

function journalIsAppendOnly(before: State, after: State, kinds: string[]): boolean {
  for (const [id, op] of Object.entries(before.operations ?? {})) if (!equal(op, after.operations?.[id])) return false;
  return Object.entries(after.operations ?? {}).every(([id, op]: [string, any]) => before.operations?.[id] || (
    kinds.includes(op.kind) && op.status === 'committed' && op.opId === id
  ));
}

function normalizeMetadata(state: State): void {
  delete state.operations;
  delete state['root-op-evidence'];
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    if (unit.meta) {
      delete unit.meta.lastEditActorType;
      delete unit.meta.sourcePartRevision;
      delete unit.meta.sourceStoryRevision;
    }
    for (const block of unit.blocks ?? []) {
      // Physical source offsets/revisions are recomputed when the engine mirrors a paragraph.
      if (block.sourceAnchor) for (const key of ['byteSpan', 'xmlSpan', 'visibleTextLength', 'partRevision', 'storyRevision']) delete block.sourceAnchor[key];
      for (const key of ['styleRef', 'splitFromBlockId', 'mergedIntoBlockId']) block[key] ??= null;
      block.structuralRefs ??= {};
      for (const key of ['numId', 'ilvl', 'tableNodeId', 'rowNodeId', 'cellNodeId']) block.structuralRefs[key] ??= null;
    }
  }
}

function recordsValid(state: State): boolean {
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    if (unit.meta?.shardKind !== 'comments') continue;
    for (const [id, record] of Object.entries(unit.records?.comments ?? {}) as [string, any][]) {
      if (record.commentId !== id || typeof record.bodyText !== 'string' || record.bodyText.length > 100_000 || typeof record.author !== 'string' || typeof record.resolved !== 'boolean') return false;
    }
  }
  return true;
}

export function commentProjection(input: State): State | null {
  const state = clone(input);
  if (!recordsValid(state)) return null;
  const commentIds = new Set<string>();
  for (const unit of Object.values(state.content ?? {}) as any[]) if (unit.meta?.shardKind === 'comments') {
    for (const id of Object.keys(unit.records?.comments ?? {})) commentIds.add(id);
    const paired = unit.meta.pairedPartKeys ?? [];
    if (paired.some((key: any) => typeof key !== 'string' || !/comments(?:Extended|Ids)?/.test(key))) return null;
    delete unit.meta.pairedPartKeys;
    if (unit.meta.allocator) delete unit.meta.allocator.commentId;
    unit.records = { ...unit.records, comments: {}, people: unit.records?.people ?? {} };
    if (unit.opaque?.sourceParts) for (const uri of Object.keys(unit.opaque.sourceParts)) {
      if (!commentParts.has(uri)) return null;
      delete unit.opaque.sourceParts[uri];
    }
  }
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    for (const block of unit.blocks ?? []) {
      const length = textOf(block).length;
      for (const atom of block.atoms ?? []) {
        if (atom.kind !== 'comment-marker') continue;
        const match = /^comment:(.+):(start|end|ref)$/.exec(atom.id ?? '');
        if (!match || !commentIds.has(match[1]) || atom.length !== 0 || !Number.isInteger(atom.visibleOffset) || atom.visibleOffset < 0 || atom.visibleOffset > length) return null;
        const tag = { start: 'commentRangeStart', end: 'commentRangeEnd', ref: 'commentReference' }[match[2]];
        if (atom.xml !== `<w:${tag} w:id="${match[1]}"/>`) return null;
      }
      for (const anchor of block.anchors ?? []) if (anchor.kind === 'comment') {
        const match = /^comment:(.+):(start|end|ref)$/.exec(anchor.id ?? '');
        if (!match || !commentIds.has(match[1]) || anchor.visibleOffset < 0 || anchor.visibleOffset > length) return null;
      }
      block.atoms = (block.atoms ?? []).filter((atom: any) => atom.kind !== 'comment-marker');
      block.anchors = (block.anchors ?? []).filter((anchor: any) => anchor.kind !== 'comment');
    }
    if (unit.meta?.shardKind === 'content-types') {
      for (const [uri, type] of Object.entries(unit.records?.overrides ?? {})) if (commentParts.has(uri)) {
        if (!commentTypes.has(typeof type === 'string' ? type : (type as any).contentType)) return null;
        delete unit.records.overrides[uri];
      }
    }
    if (unit.meta?.shardKind === 'relationships') {
      for (const [id, relationship] of Object.entries(unit.records?.relationships ?? {}) as [string, any][]) {
        const type = relationship.type ?? relationship.Type;
        if (typeof type !== 'string' || !/\/(comments|commentsExtended|commentsIds)$/.test(type)) continue;
        const target = relationship.target ?? relationship.Target;
        if (!['comments.xml', 'commentsExtended.xml', 'commentsIds.xml'].includes(target) || relationship.targetMode === 'External') return null;
        delete unit.records.relationships[id];
      }
      // Only this allocator is affected by adding a relationship to the comments part.
      if (unit.meta.allocator) delete unit.meta.allocator.rId;
    }
  }
  for (const [key, part] of Object.entries(state.package?.parts ?? {}) as [string, any][]) {
    if (commentParts.has(part.partUri)) delete state.package.parts[key];
    else if (['/[Content_Types].xml', '/word/_rels/document.xml.rels'].includes(part.partUri)) {
      delete part.uncompressedSize;
      if (part.partUri === '/[Content_Types].xml') delete part.contentType;
    }
  }
  for (const [key, shard] of Object.entries(state.shards ?? {}) as [string, any][]) {
    if (shard.kind === 'comments' || shard.shardKind === 'comments' || commentParts.has(shard.part?.partUri)) delete state.shards[key];
    else if (shard.shardKind === 'content-types' || key.includes('::content-types::')) delete shard.part?.contentType;
  }
  normalizeMetadata(state);
  return state;
}

// Return the original view of a paragraph by excluding validated inline insertions.
// Deletions, formatting revisions, paragraph/table revisions and opaque wrappers
// deliberately fall back to edit until their semantic rules are implemented.
function originalBlock(input: any): any | null {
  const block = clone(input);
  const text = textOf(block);
  const wrappers = (block.atoms ?? []).filter((atom: any) => atom.kind === 'tracked-wrapper');
  const pairs = new Map<string, { start?: any; end?: any }>();
  for (const atom of wrappers) {
    if (atom.meta?.wrapper !== 'ins' || !['start', 'end'].includes(atom.meta?.position) || !atom.meta?.rsid || atom.length !== 0) return null;
    if (atom.meta.position === 'start' ? !/^<w:ins\b[^<>]*>$/.test(atom.xml) : atom.xml !== '</w:ins>') return null;
    const pair = pairs.get(atom.meta.rsid) ?? {};
    if (pair[atom.meta.position as 'start' | 'end']) return null;
    pair[atom.meta.position as 'start' | 'end'] = atom; pairs.set(atom.meta.rsid, pair);
  }
  const ranges: [number, number][] = [];
  for (const pair of pairs.values()) {
    if (!pair.start || !pair.end) return null;
    const a = pair.start.visibleOffset, b = pair.end.visibleOffset;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b > text.length) return null;
    ranges.push([a, b]);
  }
  ranges.sort((a,b) => a[0]-b[0]);
  if (ranges.some((range,i) => i > 0 && range[0] < ranges[i-1][1])) return null;
  const originalOffset = (offset: number) => offset - ranges.reduce((sum,[a,b]) => sum + Math.max(0, Math.min(offset,b)-a), 0);
  const runs: any[] = []; let offset = 0;
  for (const run of block.text?.$text ?? []) {
    if (typeof run.insert !== 'string') return null;
    if (run.attributes?.trackedRunFormat) return null;
    for (let i=0;i<run.insert.length;i++,offset++) {
      if (ranges.some(([a,b]) => offset >= a && offset < b)) continue;
      const attrs = run.attributes ?? {};
      const last = runs.at(-1);
      if (last && equal(last.attributes, attrs)) last.insert += run.insert[i];
      else runs.push({ insert: run.insert[i], attributes: attrs });
    }
  }
  block.text = { $text: runs };
  block.atoms = (block.atoms ?? []).filter((atom: any) => atom.kind !== 'tracked-wrapper').map((atom: any) => ({ ...atom, visibleOffset: originalOffset(atom.visibleOffset) }));
  const wrapperIds = new Set(wrappers.map((atom: any) => atom.id));
  block.anchors = (block.anchors ?? []).filter((anchor: any) => !(anchor.kind === 'tracked' && wrapperIds.has(anchor.id))).map((anchor: any) => ({ ...anchor, visibleOffset: originalOffset(anchor.visibleOffset) }));
  return block;
}

function suggestionProjection(input: State): State | null {
  const state = clone(input);
  for (const unit of Object.values(state.content ?? {}) as any[]) if (unit.meta?.shardKind === 'story') {
    for (let i=0;i<(unit.blocks ?? []).length;i++) {
      const block = originalBlock(unit.blocks[i]); if (!block) return null; unit.blocks[i] = block;
    }
  }
  normalizeMetadata(state);
  return state;
}

export function classifySnapshots(before: State, after: State): { type: OperationType; reason: string } {
  const commentEffect = Object.entries(after.content ?? {}).some(([id, unit]: [string, any]) => {
    if (unit.meta?.shardKind === 'comments') return !equal(before.content?.[id], unit);
    return (unit.blocks ?? []).some((block: any, index: number) => {
      const previous = before.content?.[id]?.blocks?.[index];
      const markers = (b: any) => (b?.atoms ?? []).filter((atom: any) => atom.kind === 'comment-marker');
      return !equal(markers(previous), markers(block));
    });
  });
  const commentBefore = commentProjection(before), commentAfter = commentProjection(after);
  if (commentEffect && commentBefore && commentAfter && equal(commentBefore, commentAfter) && journalIsAppendOnly(before, after, ['insertComment', 'updateComment', 'deleteComment', 'resolveComment', 'updateCommentFields'])) {
    return { type: 'comment', reason: 'Only comment records, markers and permitted comment plumbing changed' };
  }
  const suggestionBefore = suggestionProjection(before), suggestionAfter = suggestionProjection(after);
  const trackedEffect = Object.entries(after.content ?? {}).some(([id, unit]: [string, any]) => unit.meta?.shardKind === 'story' &&
    !equal(before.content?.[id]?.blocks, unit.blocks) && unit.blocks?.some((block: any) => block.atoms?.some((atom: any) => atom.kind === 'tracked-wrapper')));
  if (trackedEffect && suggestionBefore && suggestionAfter && equal(suggestionBefore, suggestionAfter) && journalIsAppendOnly(before, after, ['editText'])) {
    return { type: 'suggestion', reason: 'Inline tracked insertion; original document content is preserved' };
  }
  return { type: 'edit', reason: 'Direct, mixed, structural or unrecognized change' };
}
