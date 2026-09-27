/**
 * Component: Audiobook Matcher Tests
 * Documentation: documentation/integrations/audible.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock() as ReturnType<typeof createPrismaMock> & {
  reportedIssue: { findMany: ReturnType<typeof vi.fn> };
};

// Add reportedIssue mock (not yet in shared helper) for getOpenIssuesByAsins
(prismaMock as any).reportedIssue = { findMany: vi.fn() };

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

describe('audiobook-matcher', () => {
  beforeEach(() => {
  vi.clearAllMocks();

  // By default, the requested ASIN has no known sibling ASINs.
  prismaMock.workAsin.findMany.mockResolvedValue([]);
});

  it('returns ASIN exact match from dedicated field', async () => {
    prismaMock.plexLibrary.findMany.mockResolvedValue([
      {
        plexGuid: 'guid-1',
        plexRatingKey: 'rating-1',
        title: 'Test Book',
        author: 'Test Author',
        asin: 'B00TEST123',
        isbn: null,
      },
    ]);

    const { findPlexMatch } = await import('@/lib/utils/audiobook-matcher');
    const match = await findPlexMatch({
      asin: 'B00TEST123',
      title: 'Test Book',
      author: 'Test Author',
    });

    expect(match?.plexGuid).toBe('guid-1');
  });

  it('matches a library item through a known regional sibling ASIN', async () => {
  // First Works query: requested ASIN belongs to this Work.
  // Second Works query: retrieve all ASINs belonging to that Work.
  prismaMock.workAsin.findMany
    .mockResolvedValueOnce([
      {
        asin: 'B009SDRTNG',
        workId: 'forgotten-work',
      },
    ])
    .mockResolvedValueOnce([
      {
        asin: 'B009SDRTNG',
        workId: 'forgotten-work',
      },
      {
        asin: 'B009ON9QK4',
        workId: 'forgotten-work',
      },
    ]);

  // Audiobookshelf contains the alternate/regional ASIN.
  prismaMock.plexLibrary.findMany.mockResolvedValue([
    {
      plexGuid: 'abs-forgotten',
      plexRatingKey: 'forgotten-rating-key',
      title: 'The Forgotten',
      author: 'David Baldacci',
      asin: 'B009ON9QK4',
      isbn: null,
    },
  ]);

  const { findPlexMatch } = await import('@/lib/utils/audiobook-matcher');

  const match = await findPlexMatch({
    asin: 'B009SDRTNG',
    title: 'The Forgotten',
    author: 'David Baldacci',
    narrator: 'Ron McLarty, Orlagh Cassidy',
  });

  expect(match).not.toBeNull();
  expect(match?.asin).toBe('B009ON9QK4');
  expect(match?.title).toBe('The Forgotten');

  // Verify that the library query included BOTH the requested ASIN
  // and its known sibling ASIN.
  expect(prismaMock.plexLibrary.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        OR: [
          { asin: 'B009SDRTNG' },
          { plexGuid: { contains: 'B009SDRTNG' } },
          { asin: 'B009ON9QK4' },
          { plexGuid: { contains: 'B009ON9QK4' } },
        ],
      },
    })
  );
});

  it('rejects candidates with mismatched ASINs in plexGuid', async () => {
    prismaMock.plexLibrary.findMany.mockResolvedValue([
      {
        plexGuid: 'com.plexapp.agents.audible://B00WRONG999',
        plexRatingKey: null,
        title: 'Test Book',
        author: 'Test Author',
        asin: null,
        isbn: null,
      },
    ]);

    const { findPlexMatch } = await import('@/lib/utils/audiobook-matcher');
    const match = await findPlexMatch({
      asin: 'B00RIGHT123',
      title: 'Test Book',
      author: 'Test Author',
    });

    expect(match).toBeNull();
  });

  it('returns null when no ASIN match exists (fuzzy matching removed)', async () => {
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);

    const { findPlexMatch } = await import('@/lib/utils/audiobook-matcher');
    const match = await findPlexMatch({
      asin: 'B00TEST999',
      title: 'Great Book',
      author: 'Different Author',
      narrator: 'Jane Narrator',
    });

    expect(match).toBeNull();
  });

  it('matches library items by ASIN or ISBN only (no fuzzy fallback)', async () => {
    const items = [
      { id: '1', externalId: 'g1', title: 'Alpha', author: 'Author A', asin: 'ASIN1' },
      { id: '2', externalId: 'g2', title: 'Beta', author: 'Author B', isbn: '978-1-23456-789-7' },
      { id: '3', externalId: 'g3', title: 'Gamma Book', author: 'Author C' },
    ];

    const { matchAudiobook } = await import('@/lib/utils/audiobook-matcher');
    const asinMatch = matchAudiobook({ title: 'x', author: 'y', asin: 'ASIN1' }, items);
    expect(asinMatch?.externalId).toBe('g1');

    const isbnMatch = matchAudiobook({ title: 'x', author: 'y', isbn: '9781234567897' }, items);
    expect(isbnMatch?.externalId).toBe('g2');

    const noMatch = matchAudiobook({ title: 'Gamma Book', author: 'Author C' }, items);
    expect(noMatch).toBeNull();
  });

  it('enriches audiobooks with availability and request status', async () => {
    prismaMock.plexLibrary.findMany
      .mockResolvedValueOnce([
        {
          plexGuid: 'guid-1',
          plexRatingKey: null,
          title: 'Book One',
          author: 'Author One',
          asin: 'ASIN1',
          isbn: null,
        },
      ])
      .mockResolvedValueOnce([]);

    prismaMock.audiobook.findMany.mockResolvedValue([
      {
        id: 'a1',
        audibleAsin: 'ASIN1',
        requests: [
          {
            id: 'r1',
            status: 'downloading',
            userId: 'other-user',
            user: { plexUsername: 'OtherUser' },
          },
        ],
      },
    ]);

    // Mock reported issues (none for this test)
    prismaMock.reportedIssue.findMany.mockResolvedValue([]);

    const { enrichAudiobooksWithMatches } = await import('@/lib/utils/audiobook-matcher');
    const results = await enrichAudiobooksWithMatches(
      [
        { asin: 'ASIN1', title: 'Book One', author: 'Author One' },
        { asin: 'ASIN2', title: 'Book Two', author: 'Author Two' },
      ],
      'current-user'
    );

    expect(results[0].isAvailable).toBe(true);
    expect(results[0].isRequested).toBe(true);
    expect(results[0].requestedByUsername).toBe('OtherUser');

    expect(results[1].isAvailable).toBe(false);
    expect(results[1].isRequested).toBe(false);
  });
});


