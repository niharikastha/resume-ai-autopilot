/**
 * The hand-kept tracker: applications the candidate made themselves, and the people who
 * might refer them.
 *
 * ITS OWN MODULE RATHER THAN A THIRD CONTROLLER ON ProfileModule, which is where the other
 * candidate-states-a-fact screens live. The difference is what the data is for. Preferences,
 * answers and the employer blocklist are all inputs to the pipeline - matching reads them,
 * submission types them into forms - so they belong beside the profile they describe.
 * Nothing in this module is an input to anything. No scheduler reads it, no processor
 * touches it, and a run with the tables empty behaves exactly as it does with five hundred
 * rows in them.
 *
 * That isolation is the feature, and a module boundary is how it stays true: the day
 * somebody wants the tracker to auto-create pipeline applications, the import they have to
 * add is the conversation about whether a log that writes to the machine is still a log.
 *
 * NO PROVIDER IS EXPORTED, for the same reason. Nothing outside should be reaching in.
 *
 * THE ONE IMPORT IS LlmModule, for Gmail sync (gmail/), and it points inward: an email
 * is read so the TRACKER can suggest a change to itself. Nothing it learns leaves this
 * module, and even here it only proposes - the candidate's Apply is what writes a row.
 */
import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { GmailSyncService } from './gmail/gmail-sync.service';
import { GmailController } from './gmail/gmail.controller';
import { GmailScheduler } from './gmail/gmail.scheduler';
import { TrackerController } from './tracker.controller';
import { TrackerService } from './tracker.service';

@Module({
  imports: [LlmModule],
  controllers: [TrackerController, GmailController],
  providers: [TrackerService, GmailSyncService, GmailScheduler],
})
export class TrackerModule {}
