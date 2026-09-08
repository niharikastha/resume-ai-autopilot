/**
 * The real browser: one window, visible, with a profile that persists between runs.
 *
 * NOT HEADLESS, AND THAT IS THE POINT. PLAN-v2 phase 6 is a handoff, not an
 * automation: the browser opens where the candidate can see it, the form arrives
 * filled, and the human reads it and clicks submit. A headless run would be a system
 * that applies to jobs on its own, which is the one thing this project has said it
 * will not do since v1 constraint 0.
 *
 * A PERSISTENT PROFILE, for three reasons that all point the same way. Sessions
 * survive, so the candidate logs into Greenhouse or Ashby once rather than every
 * morning. Chrome's own autofill accumulates, and the engine treats an
 * already-filled box as filled, so the browser's memory adds to what this system
 * knows rather than fighting it. And a browser with a history looks like a browser,
 * which matters only in the sense that a brand-new profile hitting fifteen
 * application forms is the shape of abuse.
 *
 * NO ANTI-DETECTION TOOLING, NO CAPTCHA SOLVING, NO STEALTH PLUGIN. The plan is
 * explicit and this file honours it: a challenge is a stop-and-ask. The human is
 * sitting in front of the window.
 *
 * `channel: 'chrome'` uses the Chrome already installed on the machine, which is why
 * the dependency is `playwright-core` and no browser is downloaded at install time.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { PlaywrightFormPage } from './playwright.page';
import type { FormPage } from './form-page';

/**
 * How long to wait for a form to appear.
 *
 * Generous, because Greenhouse and Ashby are single-page apps that fetch the posting
 * and then render the form, and a 5-second timeout on a slow morning connection
 * reports "no fields" for a form that was about to load.
 */
const FORM_TIMEOUT_MS = 45_000;

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private context: BrowserContext | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The window, opened on first use and reused for the rest of the run. */
  private async open(): Promise<BrowserContext> {
    if (this.context) return this.context;

    const dir = resolve(
      this.config.get<string>('BROWSER_PROFILE_DIR') ?? '.browser-profile',
    );
    await mkdir(dir, { recursive: true });

    // Imported here rather than at the top of the file so that a process which never
    // opens a browser - every other CLI command, the API, the worker - does not load
    // Playwright at boot.
    const { chromium } = await import('playwright-core');

    this.logger.log(`opening Chrome with the profile at ${dir}`);
    this.context = await chromium.launchPersistentContext(dir, {
      channel: 'chrome',
      headless: false,
      // The real window size, not a synthetic viewport. The human is going to use it.
      viewport: null,
      args: ['--start-maximized'],
    });
    return this.context;
  }

  /**
   * Navigates to an application form and returns the restricted page.
   *
   * Waits for a text input to exist rather than for `networkidle`: an application form
   * is a page with boxes on it, and analytics beacons mean networkidle never arrives on
   * several of these boards. A form that never produces one gets the page anyway, so
   * the caller can screenshot whatever did load and say so.
   */
  async visit(url: string): Promise<{ page: FormPage; raw: Page }> {
    const context = await this.open();
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: FORM_TIMEOUT_MS,
    });
    try {
      await page
        .locator('input:not([type="hidden"]), textarea, select')
        .first()
        .waitFor({ state: 'attached', timeout: FORM_TIMEOUT_MS });
    } catch {
      this.logger.warn(
        `no form field appeared at ${url} within ${FORM_TIMEOUT_MS / 1000}s - ` +
          'the posting may have closed, or the apply button may be on another page',
      );
    }

    return { page: new PlaywrightFormPage(page), raw: page };
  }

  /**
   * Closes the window.
   *
   * NOT called between applications. The candidate may still be reading the last form,
   * and closing the context would close the tab they are typing in.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.context) return;
    const context = this.context;
    this.context = null;
    await context.close().catch(() => undefined);
  }
}
