import { describe, expect, it } from 'vitest';
import { openDatasetFeeds } from './open-dataset.js';

describe('open sports dataset feeds', () => {
  it('exposes ingested footage using its real source identity and supported sport', () => {
    const event = {
      title: 'Local cycling race',
      subtitle: 'Open sports footage · test replay',
      broadcaster: { name: 'Creator' },
    };
    const feeds = openDatasetFeeds([
      { id: 'open-cycling-1', dataset: 'commons-open-v1', sportId: 'cycling', event },
      { id: 'legacy', sportId: 'cycling', event },
      { id: 'unknown', dataset: 'commons-open-v1', sportId: 'unknown', event },
      { id: 'incomplete', dataset: 'commons-open-v1', sportId: 'cycling' },
    ]);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ id: 'open-cycling-1', clipId: 'open-cycling-1', sportId: 'cycling', ...event });
    expect(feeds[0]).not.toHaveProperty('teamIds');
    expect(feeds[0]).not.toHaveProperty('competitionId');
  });
});
