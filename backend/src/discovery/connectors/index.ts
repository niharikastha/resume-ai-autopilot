/**
 * The connector registry.
 *
 * Keyed by `source`, which is what `job_postings.source` stores and what
 * `source_runs.source` groups by - so these strings are data, not labels. Renaming
 * one orphans every posting that came from it, because the upsert key is
 * `@@unique([source, sourceJobId])`.
 */
import { AtsType } from '@prisma/client';
import { AshbyConnector } from './ashby.connector';
import { CareersApiConnector } from './careers-api.connector';
import { GreenhouseConnector } from './greenhouse.connector';
import { LeverConnector } from './lever.connector';
import { SmartRecruitersConnector } from './smartrecruiters.connector';
import { WorkableConnector } from './workable.connector';
import { WorkdayConnector } from './workday.connector';
import { Connector } from './types';

export const CONNECTORS: readonly Connector[] = [
  new GreenhouseConnector(),
  new LeverConnector(),
  new AshbyConnector(),
  new SmartRecruitersConnector(),
  new WorkableConnector(),
  // Last on purpose. The probe walks this list in order and stops at the first hit,
  // so the cheap single-request sources are asked before the expensive ones - and
  // Workday is skipped by the probe entirely, since its boards cannot be guessed.
  new WorkdayConnector(),
  // Never probed (not guessable), so its position only matters for readability.
  new CareersApiConnector(),
];

const BY_SOURCE = new Map(CONNECTORS.map((c) => [c.source, c]));
const BY_ATS = new Map(CONNECTORS.map((c) => [c.atsType, c]));

export function connectorFor(source: string): Connector | undefined {
  return BY_SOURCE.get(source.toLowerCase());
}

/**
 * The connector for a company's recorded ATS.
 *
 * This is the lookup the discovery pass actually uses: companies carry an
 * `atsType` and an `atsToken`, not a source string.
 */
export function connectorForAts(ats: AtsType): Connector | undefined {
  return BY_ATS.get(ats);
}

export * from './types';
