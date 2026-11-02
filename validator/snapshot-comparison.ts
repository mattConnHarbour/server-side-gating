import { isDeepStrictEqual as equal } from 'node:util';

export type DocumentSnapshot = Record<string, any>;

/** Invalid comparisons must never qualify as equal, including two failed checks. */
export function haveSameRemainingContent(
  before: DocumentSnapshot | null,
  after: DocumentSnapshot | null,
): boolean {
  return before !== null && after !== null && equal(before, after);
}

/** Mutates only a comparison copy; the accepted document snapshot stays untouched. */
export function normalizeDocumentBookkeeping(state: DocumentSnapshot): void {
  // Normalize bookkeeping in the before and after comparison views. Source
  // offsets/revisions are recomputed when the engine mirrors a paragraph; absent
  // optional fields and explicit nulls describe the same modeled state here.
  // Journal/evidence payloads are excluded here; operation-journal.ts separately
  // checks append-only entries without certifying their repair/replay behavior.
  delete state.operations;
  delete state['root-op-evidence'];
  for (const unit of Object.values(state.content ?? {}) as any[]) {
    if (unit.meta) {
      delete unit.meta.lastEditActorType;
      delete unit.meta.sourcePartRevision;
      delete unit.meta.sourceStoryRevision;
    }
    for (const block of unit.blocks ?? []) {
      if (block.sourceAnchor) {
        for (const key of ['byteSpan', 'xmlSpan', 'visibleTextLength', 'partRevision', 'storyRevision']) {
          delete block.sourceAnchor[key];
        }
      }
      for (const key of ['styleRef', 'splitFromBlockId', 'mergedIntoBlockId']) block[key] ??= null;
      block.structuralRefs ??= {};
      for (const key of ['numId', 'ilvl', 'tableNodeId', 'rowNodeId', 'cellNodeId']) {
        block.structuralRefs[key] ??= null;
      }
    }
  }
}
