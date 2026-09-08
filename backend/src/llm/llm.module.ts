/**
 * The LLM provider, resolved once and logged.
 *
 * PLAN-v2 phase 2: "Selection: LLM_PROVIDER env wins; else gemini when
 * NODE_ENV=production, claude otherwise. Resolved once at boot and logged."
 *
 * RESOLVED ONCE matters more than it looks. Every MatchScore and Application row
 * records which provider produced it, and those records are only meaningful if the
 * answer cannot change mid-run. A helper that re-read the environment per call would
 * make a row's `llmProvider` a statement about when it was written rather than about
 * what wrote it.
 *
 * AND LOGGED matters for the same reason from the other direction: the two providers
 * do not produce identical output, so "why did today's scores shift" has a boring
 * answer often enough that the boot line should make it checkable in one grep.
 *
 * CLAUDE_AUTH_MODE is a second, independent question - the Anthropic API or AWS
 * Bedrock - and it is ClaudeProvider's, not this module's. What lands here is the
 * one line and the notes it prints, because that is what makes the answer greppable.
 */
import { Logger, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '../config/config.module';
import { Env, resolveLlmProvider } from '../config/env.schema';
import { ClaudeProvider } from './claude.provider';
import { LLM_PROVIDER, LlmProvider } from './llm.types';

const logger = new Logger('LlmModule');

/**
 * Binds the LLM_PROVIDER token to whichever implementation the environment selects.
 *
 * Gemini throws here rather than being stubbed out with something that returns
 * plausible scores. PLAN-v2 says to build Claude first and that Gemini is not needed
 * until deployment; a stub that answers would let a production deployment run for a
 * day producing garbage that looks like data, and the rows would be indistinguishable
 * from real ones afterwards.
 */
const providerFactory: Provider = {
  provide: LLM_PROVIDER,
  inject: [ConfigService, ClaudeProvider],
  useFactory: (config: ConfigService, claude: ClaudeProvider): LlmProvider => {
    // ConfigService holds the already-Zod-validated env, so these reads cannot be
    // a shape that resolveLlmProvider was not written for.
    const env = {
      LLM_PROVIDER: config.get<Env['LLM_PROVIDER']>('LLM_PROVIDER'),
      NODE_ENV: config.get<Env['NODE_ENV']>('NODE_ENV') ?? 'development',
    } as Env;

    const selected = resolveLlmProvider(env);

    if (selected === 'gemini') {
      throw new Error(
        'LLM_PROVIDER resolved to "gemini", which is not built yet (PLAN-v2 ' +
          'phase 2 builds Claude first and defers Gemini to deployment). Set ' +
          'LLM_PROVIDER=claude, or leave NODE_ENV unset for local runs.',
      );
    }

    logger.log(
      `LLM provider: ${claude.id} via ${claude.authMode()} ` +
        `(score: ${claude.modelFor('fast')}, tailor: ${claude.modelFor('deep')})`,
    );

    // Not fatal at boot on purpose - see the note on ClaudeProvider.sdk(). Loud here
    // so it is known before a cron run discovers it at 06:00. The provider owns the
    // rules because which variable matters depends on CLAUDE_AUTH_MODE, and a check
    // written here would go stale the first time a mode is added.
    for (const note of claude.bootNotes()) logger.log(`LLM provider: ${note}`);

    return claude;
  },
};

@Module({
  imports: [AppConfigModule],
  providers: [ClaudeProvider, providerFactory],
  // Only the token is exported. Nothing outside this module should be able to
  // reach ClaudeProvider by name - the point of the abstraction is that no call
  // site knows which provider it has.
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
