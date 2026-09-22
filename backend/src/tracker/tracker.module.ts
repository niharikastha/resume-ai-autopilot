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
 */
import { Module } from '@nestjs/common';
import { TrackerController } from './tracker.controller';
import { TrackerService } from './tracker.service';

@Module({
  controllers: [TrackerController],
  providers: [TrackerService],
})
export class TrackerModule {}
