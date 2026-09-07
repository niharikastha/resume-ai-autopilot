/**
 * The embedding model, as a shared provider.
 *
 * One module so one process holds one copy of the weights. Profile ingestion,
 * posting embedding and matching all resolve the same instance; three separate
 * providers would mean three onnxruntime sessions and three times the memory for
 * identical numbers.
 *
 * Nothing is loaded at boot - see the lazy `extractor()` in the service.
 */
import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';

@Module({
  providers: [EmbeddingsService],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
