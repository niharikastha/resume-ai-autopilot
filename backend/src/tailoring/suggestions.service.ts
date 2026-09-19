/**
 * "What would make this resume better?", answered against the candidate's own atoms.
 *
 * EVERY REWRITE GOES THROUGH THE PROVENANCE GUARD, one atom at a time, before the
 * candidate ever sees it. That is the whole reason this is a service and not a thin
 * passthrough to the model. A suggestion is a sentence a person will read, agree with,
 * and paste into their resume - which makes it the same risk as a tailored bullet with
 * one difference in the wrong direction: a tailored bullet is checked by a guard that
 * fails closed, and a suggestion looks like advice, so it is trusted more and checked
 * less. Here it is checked the same.
 *
 * HOW ONE SUGGESTION IS CHECKED. `checkProvenance` takes a whole `TailorOutput`, so each
 * rewrite is wrapped in a synthetic one that selects exactly the atom it cites and
 * rewrites exactly that atom, with an empty headline and cover letter - which the guard
 * skips. What that buys is that the number rule and the tech rule run over the
 * suggestion through THE SAME FUNCTION the pipeline uses, so a fabrication this misses
 * is one the real path would miss too. There is no second, weaker guard.
 *
 * A REJECTED SUGGESTION IS DROPPED, NOT SHOWN WITH A WARNING. A sentence that claims
 * 85% where the atom says 65% is not a suggestion with a caveat, and displaying it
 * beside a note asks the candidate to be the checker - which is the job this code was
 * written to stop being theirs. The count is returned and the violations are logged,
 * because a rising rejection rate is the prompt-drift signal.
 *
 * ADVICE IS NOT GUARDED, deliberately. "This bullet has no figure in it - if you know
 * how many services it was, say so" names something absent from the resume, which is
 * exactly what the guard rejects and exactly what makes advice useful. It cannot reach a
 * page: nothing applies advice, there is no field it is written into, and the only way
 * it becomes resume text is a person typing their own fact into their own bullet. That
 * is the same gate the whole system already relies on.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LLM_PROVIDER, type LlmProvider } from '../llm/llm.types';
import {
  suggestResumeTask,
  type SuggestInput,
  type SuggestOutput,
} from '../llm/tasks/suggest-resume.task';
import type { TailorOutput } from '../llm/tasks/tailor-resume.task';
import { checkProvenance, summarize } from './provenance.guard';
import { ResumeSourceService } from './resume.source';

export interface ResumeSuggestion {
  atomId: string;
  kind: 'rewrite' | 'advice';
  /** The atom's text as it stands, so the screen can show both without a second read. */
  current: string;
  /** The proposed replacement for a rewrite; the advice itself otherwise. */
  text: string;
  why: string;
}

export interface SuggestionsResult {
  resumeId: string;
  suggestions: ResumeSuggestion[];
  /** The model's view of the resume as a whole, or null when it had none. */
  overall: string | null;
  /**
   * Rewrites the guard threw out. Surfaced rather than hidden: it is the difference
   * between "the model had little to say" and "the model had plenty to say and none of
   * it was true", and those want different reactions from whoever reads the screen.
   */
  rejected: number;
  provider: string;
  model: string;
}

export interface SuggestionsRequest {
  resumeId?: string;
  /** Free text: what the candidate is aiming at. Optional. */
  focus?: string | null;
  /** Restrict the answer to these atoms. Empty or absent means the whole resume. */
  atomIds?: string[];
}

@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);

  constructor(
    private readonly source: ResumeSourceService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async suggest(
    userId: string,
    request: SuggestionsRequest = {},
  ): Promise<SuggestionsResult> {
    const source = await this.source.load(userId, request.resumeId);
    const known = new Map(source.guardAtoms.map((atom) => [atom.id, atom]));

    // Ids the caller sent that are not in this resume are dropped rather than
    // rejected. The edit screen sends the pieces it is showing, and a piece deleted in
    // another tab a moment ago should narrow the request, not fail it.
    const atomIds = (request.atomIds ?? []).filter((id) => known.has(id));

    const call = await this.llm.complete(suggestResumeTask, source.shared, {
      focus: request.focus?.trim() || null,
      atomIds,
    } satisfies SuggestInput);

    const kept: ResumeSuggestion[] = [];
    let rejected = 0;

    for (const suggestion of call.value.suggestions) {
      const atom = known.get(suggestion.atomId);
      // An id that is not in this resume: the guard would call it `unknown-atom`, and
      // there is nothing for the screen to attach it to either way.
      if (!atom) {
        rejected++;
        this.logger.warn(
          `suggestion cites atom ${suggestion.atomId}, which is not in resume ` +
            source.profile.label,
        );
        continue;
      }

      if (suggestion.kind === 'rewrite') {
        const report = checkProvenance({
          atoms: source.guardAtoms,
          allowedTech: source.shared.allowedTech,
          // One atom, one rewrite, nothing else - see the header. The empty headline
          // and cover letter are skipped by the guard rather than checked against
          // nothing.
          output: {
            selectedAtomIds: [suggestion.atomId],
            rewrites: [{ atomId: suggestion.atomId, text: suggestion.text }],
            headline: '',
            coverLetter: '',
          } satisfies TailorOutput,
        });

        if (!report.passed) {
          rejected++;
          this.logger.warn(
            `suggestion for atom ${suggestion.atomId} rejected: ${summarize(report)}`,
          );
          for (const violation of report.violations) {
            this.logger.warn(`    ${violation.kind}: ${violation.detail}`);
          }
          continue;
        }
      }

      kept.push({
        atomId: suggestion.atomId,
        kind: suggestion.kind,
        current: atom.text,
        text: suggestion.text,
        why: suggestion.why,
      });
    }

    this.logger.log(
      `${call.model} suggested ${call.value.suggestions.length} change(s) for ` +
        `${source.profile.label}: ${kept.length} kept, ${rejected} rejected`,
    );

    return {
      resumeId: source.profile.id,
      suggestions: kept,
      overall: overallOf(call.value),
      rejected,
      provider: call.provider,
      model: call.model,
    };
  }
}

/** '' is the model's way of saying it had nothing to add. Null says that in JSON. */
function overallOf(output: SuggestOutput): string | null {
  const text = output.overall.trim();
  return text.length > 0 ? text : null;
}
