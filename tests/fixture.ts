import * as Y from 'yjs';
export function fixture() {
  const doc = new Y.Doc({ gc: false });
  const content = doc.getMap('content');
  const story = new Y.Map<any>(); const blocks = new Y.Array<any>(); const block = new Y.Map<any>(); const text = new Y.Text('Original document.');
  content.set('story', story); story.set('meta', new Y.Map([['shardKind', 'story']])); story.set('blocks', blocks); blocks.push([block]);
  block.set('blockId', 'p1'); block.set('text', text); block.set('atoms', new Y.Array()); block.set('anchors', new Y.Array());
  const unit = new Y.Map<any>(); const records = new Y.Map<any>(); const comments = new Y.Map<any>();
  content.set('comments', unit); unit.set('meta', new Y.Map([['shardKind', 'comments']])); unit.set('records', records); records.set('comments', comments);
  return doc;
}
export function handles(doc: Y.Doc) {
  const content = doc.getMap<any>('content'); const block = content.get('story').get('blocks').get(0);
  return { content, block, text: block.get('text') as Y.Text, comments: content.get('comments').get('records').get('comments') as Y.Map<any> };
}
export function propose(doc: Y.Doc, change: (candidate: Y.Doc) => void) {
  const client = new Y.Doc({ gc: false }); client.getMap('content'); Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  const vector = Y.encodeStateVector(client); change(client); const update = Y.encodeStateAsUpdate(client, vector); client.destroy(); return update;
}
export function comment(doc: Y.Doc) { handles(doc).comments.set('c1', new Y.Map<any>([['commentId', 'c1'], ['bodyText', 'Review this'], ['author', 'Reviewer'], ['resolved', false]])); }
export function suggestion(doc: Y.Doc) {
  doc.transact(() => {
  const { block, text } = handles(doc); const start = text.length; text.insert(start, ' proposed');
  const atom = (position: string, offset: number) => new Y.Map<any>([['id', `r1:${position}`], ['kind', 'tracked-wrapper'], ['visibleOffset', offset], ['length', 0], ['xml', position === 'start' ? '<w:ins w:id="1" w:author="Reviewer">' : '</w:ins>'], ['meta', { wrapper: 'ins', position, rsid: 'r1' }]]);
  block.get('atoms').push([atom('start', start), atom('end', text.length)]);
  });
}
