import type { OperationType } from './index.js';
import { hasCommentChanges, prepareCommentComparison } from './comment-checks.js';
import { hasTrackedInsertionChanges, prepareSuggestionComparison } from './suggestion-checks.js';
import { hasValidCommentJournal, hasValidSuggestionJournal } from './operation-journal.js';
import { haveSameRemainingContent, type DocumentSnapshot } from './snapshot-comparison.js';

/**
 * Classify an update's effects against the accepted document snapshot.
 * This prototype recognizes comments and inline tracked insertions; it does not
 * certify arbitrary revisions, journal repair/replay behavior, or authorship.
 */
export function classifySnapshots(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): { type: OperationType; reason: string } {
  // A comment classification requires every remaining document field to match
  // after validating and excluding supported comment data from each snapshot.
  if (hasCommentChanges(before, after)) {
    const beforeWithoutComments = prepareCommentComparison(before);
    if (beforeWithoutComments) {
      const afterWithoutComments = prepareCommentComparison(after);
      if (
        haveSameRemainingContent(beforeWithoutComments, afterWithoutComments) &&
        hasValidCommentJournal(before, after)
      ) {
        return { type: 'comment', reason: 'Only comment records, markers and permitted comment plumbing changed' };
      }
    }
  }

  // Start from the original snapshots so comment exclusions cannot hide an edit.
  // Removing supported tracked insertions must leave the same original content.
  if (hasTrackedInsertionChanges(before, after)) {
    const originalContentBefore = prepareSuggestionComparison(before);
    if (originalContentBefore) {
      const originalContentAfter = prepareSuggestionComparison(after);
      if (
        haveSameRemainingContent(originalContentBefore, originalContentAfter) &&
        hasValidSuggestionJournal(before, after)
      ) {
        return { type: 'suggestion', reason: 'Inline tracked insertion; original document content is preserved' };
      }
    }
  }

  // Mixed changes and unsupported representations require the broader edit permission.
  return { type: 'edit', reason: 'Direct, mixed, structural or unrecognized change' };
}
