/**
 * Profile ingestion, as a module.
 *
 * No controller yet. Ingestion is a CLI command because the confirmation gate is
 * a conversation - print the atoms, let a human read them, write only on
 * `--confirm` - and a single HTTP request is a poor shape for that. When the web
 * app grows an upload screen it wants the same two steps: POST the file to get a
 * preview with a null `confirmedAt`, then PATCH to confirm. `ProfileService`
 * already splits along that line, so the controller is additive.
 */
import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ProfileService } from './profile.service';

@Module({
  imports: [EmbeddingsModule],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
