/**
 * Where you will work, over HTTP.
 *
 * Under /api/me and scoped by the session, like every other route in this family: a
 * preference is read and written for whoever is signed in, and no route takes a user
 * id. An admin cannot set a candidate's cities here, deliberately - the same rule
 * ApplicationAnswers follows, and for the same reason. Guessing that somebody would
 * relocate is not an administrative act.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { CITY_IDS } from '../config/india-cities';
import { matchesNothing } from '../config/locations';
import { PreferencesService } from './preferences.service';

const locationsBody = z
  .object({
    // Ids from the catalogue and nothing else. A free-text city would be a term
    // injected straight into the matcher's word list, and one that matched nothing
    // would look identical to a city with no jobs in it.
    cities: z
      .array(z.string().trim())
      // Cannot exceed the catalogue: a request naming more ids than there are cities
      // is not a preference somebody expressed on the screen.
      .max(CITY_IDS.size)
      .transform((list) => [...new Set(list)])
      .refine(
        (list) => list.every((id) => CITY_IDS.has(id)),
        'unknown city. Pick from the list the screen was given.',
      ),
    anywhereInIndia: z.boolean(),
    remoteIndia: z.boolean(),
    remoteUnspecified: z.boolean(),
    remoteOutsideIndia: z.boolean(),
  })
  .strict()
  // The one combination that is valid field by field and empties the pipeline. Refused
  // here rather than accepted and reported later, because "0 new matches" every
  // morning is indistinguishable from a quiet job market.
  .refine(
    (value) => !matchesNothing(value),
    'that would match nothing at all: pick at least one city, or turn on anywhere ' +
      'in India, or accept one kind of remote work.',
  );

@Controller('api/me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  view(@CurrentUser() user: SessionUser) {
    return this.preferences.view(user.id);
  }

  /**
   * PUT and not PATCH: the body is the whole preference.
   *
   * A partial update would mean the server merging checkbox state, and the failure
   * that produces is a city the candidate unticked staying on because its key was
   * simply absent from the request.
   */
  @Put()
  save(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const result = locationsBody.safeParse(body);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
        ),
      );
    }
    return this.preferences.save(user.id, result.data);
  }
}
