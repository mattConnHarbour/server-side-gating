import { isDeepStrictEqual as equal } from 'node:util';
import { normalizeDocumentBookkeeping, type DocumentSnapshot } from './snapshot-comparison.js';

// Limit comment-related package changes to the three Word comment parts
// recognized by this prototype. Other package content must remain comparable.
const commentParts = new Set([
  '/word/comments.xml',
  '/word/commentsExtended.xml',
  '/word/commentsIds.xml',
]);
const commentTypes = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  'application/vnd.ms-word.commentsExtended+xml',
  'application/vnd.ms-word.commentsIds+xml',
]);

export function hasCommentChanges(before: DocumentSnapshot, after: DocumentSnapshot): boolean {
  // Detect a candidate comment effect. The caller must still compare the rest
  // of the document so a comment cannot conceal a simultaneous direct edit.
  let hasCommentEffect = false;
  for (const [id, unit] of Object.entries(after.content ?? {}) as [string, any][]) {
    if (unit.meta?.shardKind === 'comments') {
      if (!equal(before.content?.[id], unit)) hasCommentEffect = true;
    } else {
      for (const [index, block] of (unit.blocks ?? []).entries()) {
        const previous = before.content?.[id]?.blocks?.[index];
        const previousMarkers = (previous?.atoms ?? []).filter((atom: any) => atom.kind === 'comment-marker');
        const currentMarkers = (block.atoms ?? []).filter((atom: any) => atom.kind === 'comment-marker');
        if (!equal(previousMarkers, currentMarkers)) hasCommentEffect = true;
      }
    }
    if (hasCommentEffect) return true;
  }
  return false;
}

/** Validate before excluding category-specific data from an isolated comparison copy. */
export function prepareCommentComparison(input: DocumentSnapshot): DocumentSnapshot | null {
  const state = structuredClone(input);
  // Check comment record identities and basic field types before treating
  // their contents as permitted comment changes. The text cap is 100,000 characters.
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    if (unit.meta?.shardKind !== 'comments') continue;

    for (const [id, record] of Object.entries(unit.records?.comments ?? {}) as [string, any][]) {
      if (
        record.commentId !== id ||
        typeof record.bodyText !== 'string' ||
        record.bodyText.length > 100_000 ||
        typeof record.author !== 'string' ||
        typeof record.resolved !== 'boolean'
      ) {
        return null;
      }
    }
  }

  // Collect valid comment IDs for the story-anchor checks. Remove modeled
  // comment bodies and their allocation/source bookkeeping from this view.
  // Keep people records and unrelated unit fields so changes to them still differ.
  const commentIds = new Set<string>();
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    if (unit.meta?.shardKind !== 'comments') continue;

    for (const id of Object.keys(unit.records?.comments ?? {})) commentIds.add(id);
    const pairedParts = unit.meta.pairedPartKeys ?? [];
    if (pairedParts.some((key: any) => typeof key !== 'string' || !/comments(?:Extended|Ids)?/.test(key))) {
      return null;
    }

    delete unit.meta.pairedPartKeys;
    if (unit.meta.allocator) delete unit.meta.allocator.commentId;
    unit.records = {
      ...unit.records,
      comments: {},
      people: unit.records?.people ?? {},
    };

    for (const uri of Object.keys(unit.opaque?.sourceParts ?? {})) {
      if (!commentParts.has(uri)) {
        return null;
      }
      delete unit.opaque.sourceParts[uri];
    }
  }

  for (const unit of Object.values(state.content ?? {}) as any[]) {
    for (const block of unit.blocks ?? []) {
      // Comment creation also writes markers into story content. Check that
      // they reference a known comment, stay within the text, and use the expected
      // marker XML before removing them. Leave text and other atoms untouched.
      const text = (block.text?.$text ?? [])
        .map((run: any) => typeof run.insert === 'string' ? run.insert : '\ufffc')
        .join('');

      for (const atom of block.atoms ?? []) {
        if (atom.kind !== 'comment-marker') continue;
        const match = /^comment:(.+):(start|end|ref)$/.exec(atom.id ?? '');
        if (
          !match ||
          !commentIds.has(match[1]) ||
          atom.length !== 0 ||
          !Number.isInteger(atom.visibleOffset) ||
          atom.visibleOffset < 0 ||
          atom.visibleOffset > text.length
        ) {
          return null;
        }

        const tag = {
          start: 'commentRangeStart',
          end: 'commentRangeEnd',
          ref: 'commentReference',
        }[match[2]];
        if (atom.xml !== `<w:${tag} w:id="${match[1]}"/>`) {
          return null;
        }
      }

      for (const anchor of block.anchors ?? []) {
        if (anchor.kind !== 'comment') continue;
        const match = /^comment:(.+):(start|end|ref)$/.exec(anchor.id ?? '');
        if (
          !match ||
          !commentIds.has(match[1]) ||
          anchor.visibleOffset < 0 ||
          anchor.visibleOffset > text.length
        ) {
          return null;
        }
      }

      block.atoms = (block.atoms ?? []).filter((atom: any) => atom.kind !== 'comment-marker');
      block.anchors = (block.anchors ?? []).filter((anchor: any) => anchor.kind !== 'comment');
    }

    // The first comment can register a package content type and relationship.
    // Exclude only recognized comment registrations from the comparison.
    if (unit.meta?.shardKind === 'content-types') {
      for (const [uri, type] of Object.entries(unit.records?.overrides ?? {})) {
        if (!commentParts.has(uri)) continue;
        const contentType = typeof type === 'string' ? type : (type as any).contentType;
        if (!commentTypes.has(contentType)) {
          return null;
        }
        delete unit.records.overrides[uri];
      }
    }

    if (unit.meta?.shardKind === 'relationships') {
      for (const [id, relationship] of Object.entries(unit.records?.relationships ?? {}) as [string, any][]) {
        const type = relationship.type ?? relationship.Type;
        if (typeof type !== 'string' || !/\/(comments|commentsExtended|commentsIds)$/.test(type)) continue;
        const target = relationship.target ?? relationship.Target;
        if (
          !['comments.xml', 'commentsExtended.xml', 'commentsIds.xml'].includes(target) ||
          relationship.targetMode === 'External'
        ) {
          return null;
        }
        delete unit.records.relationships[id];
      }
      if (unit.meta.allocator) delete unit.meta.allocator.rId;
    }
  }

  // Exclude corresponding comment-part descriptors and container size/type
  // bookkeeping. Preserve the rest of the package and shard manifests.
  for (const [key, part] of Object.entries(state.package?.parts ?? {}) as [string, any][]) {
    if (commentParts.has(part.partUri)) {
      delete state.package.parts[key];
    } else if (['/[Content_Types].xml', '/word/_rels/document.xml.rels'].includes(part.partUri)) {
      delete part.uncompressedSize;
      if (part.partUri === '/[Content_Types].xml') delete part.contentType;
    }
  }
  for (const [key, shard] of Object.entries(state.shards ?? {}) as [string, any][]) {
    if (shard.kind === 'comments' || shard.shardKind === 'comments' || commentParts.has(shard.part?.partUri)) {
      delete state.shards[key];
    } else if (shard.shardKind === 'content-types' || key.includes('::content-types::')) {
      delete shard.part?.contentType;
    }
  }

  normalizeDocumentBookkeeping(state);
  return state;
}
