import { isDeepStrictEqual as equal } from 'node:util';
import type { DocumentSnapshot } from './snapshot-comparison.js';

export function hasValidCommentJournal(before: DocumentSnapshot, after: DocumentSnapshot): boolean {
  return hasOnlyCommittedNewOperations(before, after, [
    'insertComment', 'updateComment', 'deleteComment', 'resolveComment', 'updateCommentFields',
  ]);
}

export function hasValidSuggestionJournal(before: DocumentSnapshot, after: DocumentSnapshot): boolean {
  return hasOnlyCommittedNewOperations(before, after, ['editText']);
}

// Journal labels supplement content comparison; they cannot establish the operation type alone.
// This append-only check does not certify journal repair/replay behavior or authorship.
function hasOnlyCommittedNewOperations(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  allowedKinds: readonly string[],
): boolean {
  let journalValid = true;
  for (const [id, operation] of Object.entries(before.operations ?? {})) {
    if (!equal(operation, after.operations?.[id])) {
      journalValid = false;
      break;
    }
  }

  for (const [id, operation] of Object.entries(after.operations ?? {}) as [string, any][]) {
    if (before.operations?.[id]) continue;
    if (!allowedKinds.includes(operation.kind) || operation.status !== 'committed' || operation.opId !== id) {
      journalValid = false;
      break;
    }
  }
  return journalValid;
}
