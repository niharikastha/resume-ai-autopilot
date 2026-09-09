/**
 * Profile ingestion and the resume library.
 *
 * WAS CLI-ONLY, and the docstring here said a controller would be additive when
 * the web app grew an upload screen, because `ProfileService` already splits along
 * the preview/commit line the gate needs. That turned out to be true: the
 * controller adds routes and the service underneath is unchanged.
 *
 * The CLI path still exists and is still the one to reach for when a parse needs
 * arguing with - a terminal is a better place to read forty atoms than a browser
 * is - so `profile:ingest` and the screen are two front doors onto one gate rather
 * than two implementations of it.
 */
import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { AnswersController } from './answers.controller';
import { AnswersService } from './answers.service';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { ProfileService } from './profile.service';
import { ResumeLibraryService } from './resume-library.service';
import { ResumeController } from './resume.controller';

@Module({
  imports: [EmbeddingsModule],
  // PreferencesController is here rather than in a module of its own because it is
  // the same thing this module already owns: facts about the candidate that only the
  // candidate can state. MatchingService does NOT go through the service - it reads
  // the row itself via a pure mapping in config/locations.ts, so the two CLI
  // containers that assemble matching by hand need no extra provider.
  // AnswersController is here for the same reason: work authorization, notice period
  // and CTC are facts only the candidate can state. The submission path reads the row
  // it writes, and the conversion between the two lives in submission/answers.ts so
  // the screen shows exactly what the filler will type.
  controllers: [ResumeController, PreferencesController, AnswersController],
  providers: [
    ProfileService,
    ResumeLibraryService,
    PreferencesService,
    AnswersService,
  ],
  exports: [ProfileService, ResumeLibraryService],
})
export class ProfileModule {}
