/**
 * Component: Works Service
 * Documentation: documentation/integrations/audible.md
 *
 * Manages the works table — persistent cross-ASIN audiobook identity mapping.
 * Layer 1: Auto-populated from dedup logic when users browse search/author/series pages.
 * Layer 2: Seeded at request time to ensure requested ASINs are tracked.
 */

import { prisma } from '@/lib/db';
import { RMABLogger } from '@/lib/utils/logger';
import {
  metadataScore,
  areDurationsCompatible,
  type DedupGroup,
} from '@/lib/utils/deduplicate-audiobooks';
import type { AudibleAudiobook } from '@/lib/integrations/audible.service';

const logger = RMABLogger.create('WorksService');

// ---------------------------------------------------------------------------
// Layer 1: Persist dedup groups (fire-and-forget from API routes)
// ---------------------------------------------------------------------------

/**
 * Persist dedup groups to the works table. For each group of 2+ ASINs that
 * were identified as the same audiobook, create or update a Work record
 * linking all ASINs together.
 *
 * Safe to call fire-and-forget — never throws.
 */
export async function persistDedupGroups(groups: DedupGroup[]): Promise<void> {
  try {
    for (const group of groups) {
      await persistSingleGroup(group);
    }
  } catch (error) {
    logger.error('Failed to persist dedup groups', {
      error: error instanceof Error ? error.message : String(error),
      groupCount: groups.length,
    });
  }
}

/**
 * Persist a single dedup group. Handles merging when ASINs span multiple
 * existing works.
 */
async function persistSingleGroup(group: DedupGroup): Promise<void> {
  const { canonicalAsin, allAsins, title, author, narrator, durationMinutes } = group;

  // Find which of these ASINs already exist in work_asins
  const existingEntries = await prisma.workAsin.findMany({
    where: { asin: { in: allAsins } },
    select: { asin: true, workId: true },
  });

  // Collect unique work IDs that already contain any of our ASINs
  const existingWorkIds = [...new Set(existingEntries.map(e => e.workId))];
  const existingAsinSet = new Set(existingEntries.map(e => e.asin));

  if (existingWorkIds.length === 0) {
    // No existing works — create a new one with all ASINs
    const work = await prisma.work.create({
      data: { title, author },
    });

    await Promise.all(
      allAsins.map(asin =>
        prisma.workAsin.create({
          data: {
            workId: work.id,
            asin,
            narrator: asin === canonicalAsin ? narrator : undefined,
            durationMinutes: asin === canonicalAsin ? durationMinutes : undefined,
            isCanonical: asin === canonicalAsin,
            source: 'dedup_auto',
          },
        })
      )
    );

    logger.debug('Created new work', { workId: work.id, asinCount: allAsins.length });
  } else {
    // Use the first existing work as the target
    const targetWorkId = existingWorkIds[0];

    // If multiple existing works, merge them into the target
    if (existingWorkIds.length > 1) {
      const mergeWorkIds = existingWorkIds.slice(1);

      // Move all ASINs from other works to the target
      await prisma.workAsin.updateMany({
        where: { workId: { in: mergeWorkIds } },
        data: { workId: targetWorkId },
      });

      // Delete the now-empty works
      await prisma.work.deleteMany({
        where: { id: { in: mergeWorkIds } },
      });

      logger.debug('Merged works', {
        targetWorkId,
        mergedWorkIds: mergeWorkIds,
      });
    }

    // Add any new ASINs that don't already exist
    const newAsins = allAsins.filter(a => !existingAsinSet.has(a));
    if (newAsins.length > 0) {
      await Promise.all(
        newAsins.map(asin =>
          prisma.workAsin.create({
            data: {
              workId: targetWorkId,
              asin,
              narrator: asin === canonicalAsin ? narrator : undefined,
              durationMinutes: asin === canonicalAsin ? durationMinutes : undefined,
              isCanonical: asin === canonicalAsin,
              source: 'dedup_auto',
            },
          })
        )
      );

      logger.debug('Added ASINs to existing work', {
        workId: targetWorkId,
        newAsinCount: newAsins.length,
      });
    }

    // Update canonical status: ensure the canonical ASIN is marked
    await prisma.workAsin.updateMany({
      where: { workId: targetWorkId, asin: canonicalAsin },
      data: { isCanonical: true },
    });
  }
}

function normalizeIdentityValue(value?: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNarratorIdentity(narrator?: string): string {
  return (narrator || '')
    .toLowerCase()
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
    .sort()
    .join(', ');
}

// ---------------------------------------------------------------------------
// Layer 2: Seed ASIN at request time
// ---------------------------------------------------------------------------

/**
 * Ensure an ASIN is tracked in the works table. Creates a single-ASIN work
 * if the ASIN isn't already present. Called at request creation time.
 *
 * Safe to call fire-and-forget — never throws.
 */
export async function seedAsin(
  asin: string,
  title: string,
  author: string,
  narrator?: string,
  durationMinutes?: number
): Promise<void> {
  try {
    const existing = await prisma.workAsin.findUnique({
      where: { asin },
    });

    const normalizedTitle = normalizeIdentityValue(title);
    const normalizedAuthor = normalizeIdentityValue(author);
    const normalizedNarrator = normalizeNarratorIdentity(narrator);

    // Conservative reconciliation:
    // Require title + author + narrator before attempting to associate
    // regional/alternate ASINs with an existing Work.
    if (normalizedTitle && normalizedAuthor && normalizedNarrator) {
      const candidateWorks = await prisma.work.findMany({
        include: {
          asins: true,
        },
      });

      const compatibleWorks = candidateWorks.filter(work => {
        // Do not compare an already-tracked ASIN against its own current Work.
        if (existing && work.id === existing.workId) {
          return false;
        }

        if (normalizeIdentityValue(work.title) !== normalizedTitle) {
          return false;
        }

        if (normalizeIdentityValue(work.author) !== normalizedAuthor) {
          return false;
        }

        return work.asins.some(entry => {
          const existingNarrator = normalizeNarratorIdentity(
            entry.narrator ?? undefined
          );

          if (
            !existingNarrator ||
            existingNarrator !== normalizedNarrator
          ) {
            return false;
          }

          return areDurationsCompatible(
            entry.durationMinutes ?? undefined,
            durationMinutes
          );
        });
      });

      // Only reconcile when exactly one other compatible Work exists.
      if (compatibleWorks.length === 1) {
        const targetWork = compatibleWorks[0];

        if (existing) {
          const oldWorkId = existing.workId;

          // Move this already-tracked ASIN to the compatible Work.
          // It is not canonical there; preserve the target Work's canonical ASIN.
          await prisma.workAsin.update({
            where: { asin },
            data: {
              workId: targetWork.id,
              narrator,
              durationMinutes,
              isCanonical: false,
            },
          });

          // Remove the old Work only if it no longer contains any ASINs.
          const remainingEntries = await prisma.workAsin.count({
            where: { workId: oldWorkId },
          });

          if (remainingEntries === 0) {
            await prisma.work.delete({
              where: { id: oldWorkId },
            });
          }

          logger.info('Reconciled existing ASIN with compatible work', {
            asin,
            oldWorkId,
            workId: targetWork.id,
            title,
            author,
          });

          return;
        }

        // New ASIN: attach it directly to the compatible Work.
        await prisma.workAsin.create({
          data: {
            workId: targetWork.id,
            asin,
            narrator,
            durationMinutes,
            isCanonical: false,
            source: 'dedup_auto',
          },
        });

        logger.info('Reconciled ASIN with existing work', {
          workId: targetWork.id,
          asin,
          title,
          author,
        });

        return;
      }

      if (compatibleWorks.length > 1) {
        logger.warn(
          'Multiple compatible works found; skipping automatic reconciliation',
          {
            asin,
            title,
            author,
            compatibleWorkIds: compatibleWorks.map(work => work.id),
          }
        );

        // Already tracked: safest action is to leave it exactly where it is.
        if (existing) return;
      }
    }

    // Existing ASIN with no single safe reconciliation target:
    // preserve its current Work.
    if (existing) return;

    // New ASIN with no safe existing match: create a new Work.
    const work = await prisma.work.create({
      data: { title, author },
    });

    await prisma.workAsin.create({
      data: {
        workId: work.id,
        asin,
        narrator,
        durationMinutes,
        isCanonical: true,
        source: 'dedup_auto',
      },
    });

    logger.debug('Seeded ASIN', { workId: work.id, asin });
  } catch (error) {
    logger.error('Failed to seed ASIN', {
      error: error instanceof Error ? error.message : String(error),
      asin,
    });
  }
}

// ---------------------------------------------------------------------------
// View-level collapse (consult the works table after local dedup)
// ---------------------------------------------------------------------------

/**
 * Collapse books that already share a Work record according to the works table.
 *
 * The local `deduplicateAndCollectGroups()` pass is title/narrator/duration-based
 * and stateless — it can fail to merge ASINs whose source metadata diverges (e.g.
 * a series-page scrape captures different "first narrators" for two ASINs of the
 * same recording, or two paginated pages each contain one ASIN and never compare
 * them). The works table is the durable source of truth for "same book" identity,
 * populated by every prior dedup pass and by request-time seeding. This pass
 * applies that knowledge to the current view.
 *
 * Behavior:
 *  - Books whose ASINs map to a shared workId collapse to a single representative
 *    chosen by `metadataScore()` (same ranking as local dedup).
 *  - Books not present in any work, or in single-ASIN works, pass through untouched.
 *  - Original ordering is preserved (the kept representative sits at the position
 *    of the first occurrence of its work in the input list).
 *  - DB failure is non-fatal: the input list is returned unchanged so the view
 *    still renders (degrades to local-dedup-only behavior).
 */
export async function collapseByExistingWorks(
  books: AudibleAudiobook[],
): Promise<AudibleAudiobook[]> {
  if (books.length <= 1) return books;

  try {
    const asins = books.map(b => b.asin);
    const entries = await prisma.workAsin.findMany({
      where: { asin: { in: asins } },
      select: { asin: true, workId: true },
    });

    if (entries.length === 0) return books;

    // Map ASIN → workId for fast lookup in the loop below
    const asinToWorkId = new Map<string, string>();
    for (const entry of entries) {
      asinToWorkId.set(entry.asin, entry.workId);
    }

    // Walk the input once, preserving position. For each work seen, keep a
    // running "best" book; for books not in any work, emit immediately.
    const result: AudibleAudiobook[] = [];
    const workIdToResultIndex = new Map<string, number>();

    for (const book of books) {
      const workId = asinToWorkId.get(book.asin);
      if (!workId) {
        result.push(book);
        continue;
      }

      const existingIndex = workIdToResultIndex.get(workId);
      if (existingIndex === undefined) {
        workIdToResultIndex.set(workId, result.length);
        result.push(book);
        continue;
      }

      // A sibling from this work is already in the result. Keep whichever
      // has the richer metadata; on tie, keep the earlier entry (already there).
      const existing = result[existingIndex];
      if (metadataScore(book) > metadataScore(existing)) {
        result[existingIndex] = book;
      }
    }

    const collapsed = books.length - result.length;
    if (collapsed > 0) {
      logger.debug('Collapsed books via works table', {
        inputCount: books.length,
        outputCount: result.length,
        collapsed,
      });
    }

    return result;
  } catch (error) {
    logger.error('collapseByExistingWorks failed; returning input unchanged', {
      error: error instanceof Error ? error.message : String(error),
      bookCount: books.length,
    });
    return books;
  }
}

// ---------------------------------------------------------------------------
// Sibling ASIN lookup (for library matching expansion)
// ---------------------------------------------------------------------------

/**
 * Given a list of ASINs, return a map of each input ASIN to its sibling ASINs
 * (other ASINs in the same work, NOT including the input ASIN itself).
 *
 * ASINs not found in the works table are simply omitted from the result.
 */
export async function getSiblingAsins(
  asins: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (asins.length === 0) return result;

  // Step 1: Find which input ASINs are in work_asins and their work IDs
  const inputEntries = await prisma.workAsin.findMany({
    where: { asin: { in: asins } },
    select: { asin: true, workId: true },
  });

  if (inputEntries.length === 0) return result;

  // Build map of workId -> input ASINs in that work
  const workIdToInputAsins = new Map<string, string[]>();
  for (const entry of inputEntries) {
    const list = workIdToInputAsins.get(entry.workId);
    if (list) {
      list.push(entry.asin);
    } else {
      workIdToInputAsins.set(entry.workId, [entry.asin]);
    }
  }

  // Step 2: Get ALL ASINs in those works
  const workIds = [...workIdToInputAsins.keys()];
  const allWorkAsins = await prisma.workAsin.findMany({
    where: { workId: { in: workIds } },
    select: { asin: true, workId: true },
  });

  // Build map of workId -> all ASINs
  const workIdToAllAsins = new Map<string, string[]>();
  for (const entry of allWorkAsins) {
    const list = workIdToAllAsins.get(entry.workId);
    if (list) {
      list.push(entry.asin);
    } else {
      workIdToAllAsins.set(entry.workId, [entry.asin]);
    }
  }

  // Step 3: For each input ASIN, compute siblings (all ASINs in same work minus self)
  for (const entry of inputEntries) {
    const allInWork = workIdToAllAsins.get(entry.workId) || [];
    const siblings = allInWork.filter(a => a !== entry.asin);
    if (siblings.length > 0) {
      result.set(entry.asin, siblings);
    }
  }

  return result;
}
