import { isDeepStrictEqual as equal } from 'node:util';
import { normalizeDocumentBookkeeping, type DocumentSnapshot } from './snapshot-comparison.js';

export function hasTrackedInsertionChanges(before: DocumentSnapshot, after: DocumentSnapshot): boolean {
  // A wrapper identifies a candidate revision. Its presence does not establish
  // that the wrapper is supported or that the rest of the document is unchanged.
  return Object.entries(after.content ?? {}).some(([id, unit]: [string, any]) =>
    unit.meta?.shardKind === 'story' &&
    !equal(before.content?.[id]?.blocks, unit.blocks) &&
    unit.blocks?.some((block: any) => block.atoms?.some((atom: any) => atom.kind === 'tracked-wrapper')),
  );
}

/** Validate before excluding category-specific data from an isolated comparison copy. */
export function prepareSuggestionComparison(input: DocumentSnapshot): DocumentSnapshot | null {
  const state = structuredClone(input);
  // Build an original-content view of each story paragraph. This prototype
  // supports inline insertion wrappers only; deletion/formatting/structural
  // revisions remain unrecognized and eventually fall back to edit.
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    if (unit.meta?.shardKind !== 'story') continue;

    for (const block of unit.blocks ?? []) {
      const text = (block.text?.$text ?? [])
        .map((run: any) => typeof run.insert === 'string' ? run.insert : '\ufffc')
        .join('');
      const wrappers = (block.atoms ?? []).filter((atom: any) => atom.kind === 'tracked-wrapper');
      const pairs = new Map<string, { start?: any; end?: any }>();

      // Require one supported start and end marker per revision ID. An
      // update cannot qualify merely by carrying an arbitrary tracked marker.
      for (const atom of wrappers) {
        if (
          atom.meta?.wrapper !== 'ins' ||
          !['start', 'end'].includes(atom.meta?.position) ||
          !atom.meta?.rsid ||
          atom.length !== 0
        ) {
          return null;
        }
        const position = atom.meta.position as 'start' | 'end';
        const xmlMatches = position === 'start'
          ? /^<w:ins\b[^<>]*>$/.test(atom.xml)
          : atom.xml === '</w:ins>';
        if (!xmlMatches) {
          return null;
        }

        const pair = pairs.get(atom.meta.rsid) ?? {};
        if (pair[position]) {
          return null;
        }
        pair[position] = atom;
        pairs.set(atom.meta.rsid, pair);
      }

      // Resolve complete, non-overlapping insertion ranges within the text.
      // Offsets use UTF-16 code units, matching Yjs/SuperDoc text coordinates.
      const ranges: [number, number][] = [];
      for (const pair of pairs.values()) {
        if (!pair.start || !pair.end) {
          return null;
        }
        const start = pair.start.visibleOffset;
        const end = pair.end.visibleOffset;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
          return null;
        }
        ranges.push([start, end]);
      }
      ranges.sort((a, b) => a[0] - b[0]);
      if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) {
        return null;
      }

      // Exclude inserted characters while retaining the formatting of every
      // original character. A direct change outside an insertion then survives
      // in this view and prevents the snapshots from comparing equal.
      const originalRuns: any[] = [];
      let offset = 0;
      for (const run of block.text?.$text ?? []) {
        if (typeof run.insert !== 'string' || run.attributes?.trackedRunFormat) {
          return null;
        }
        for (let index = 0; index < run.insert.length; index++, offset++) {
          if (ranges.some(([start, end]) => offset >= start && offset < end)) continue;
          const attributes = run.attributes ?? {};
          const previousRun = originalRuns.at(-1);
          if (previousRun && equal(previousRun.attributes, attributes)) {
            previousRun.insert += run.insert[index];
          } else {
            originalRuns.push({ insert: run.insert[index], attributes });
          }
        }
      }
      block.text = { $text: originalRuns };

      // Remove insertion wrappers and their matching tracked anchors. Move
      // remaining atoms/anchors back into original-text coordinates so an
      // unchanged bookmark or comment is not mistaken for an unrelated edit.
      const originalAtoms = [];
      for (const atom of block.atoms ?? []) {
        if (atom.kind === 'tracked-wrapper') continue;
        const insertedBefore = ranges.reduce(
          (sum, [start, end]) => sum + Math.max(0, Math.min(atom.visibleOffset, end) - start),
          0,
        );
        originalAtoms.push({ ...atom, visibleOffset: atom.visibleOffset - insertedBefore });
      }
      block.atoms = originalAtoms;

      const wrapperIds = new Set(wrappers.map((atom: any) => atom.id));
      const originalAnchors = [];
      for (const anchor of block.anchors ?? []) {
        if (anchor.kind === 'tracked' && wrapperIds.has(anchor.id)) continue;
        const insertedBefore = ranges.reduce(
          (sum, [start, end]) => sum + Math.max(0, Math.min(anchor.visibleOffset, end) - start),
          0,
        );
        originalAnchors.push({ ...anchor, visibleOffset: anchor.visibleOffset - insertedBefore });
      }
      block.anchors = originalAnchors;
    }
  }

  normalizeDocumentBookkeeping(state);
  return state;
}
