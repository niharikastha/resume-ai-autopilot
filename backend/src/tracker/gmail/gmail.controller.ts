/**
 * Gmail sync, over HTTP. Under /api/me like the tracker it feeds, and scoped by session.
 *
 * THE CALLBACK IS THE ONE @Public ROUTE, because it is Google's redirect and not the app
 * that loads it. It does not trust whatever cookie arrives with it: the user is whoever
 * the signed `state` names, and a state only this server can mint - see SecretBox.
 */
import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  CurrentUser,
  Public,
  type SessionUser,
} from '../../auth/auth.constants';
import { GmailSyncService } from './gmail-sync.service';

@Controller('api/me/gmail')
export class GmailController {
  constructor(private readonly gmail: GmailSyncService) {}

  @Get()
  status(@CurrentUser() user: SessionUser) {
    return this.gmail.status(user.id);
  }

  @Post('connect')
  connect(@CurrentUser() user: SessionUser) {
    return this.gmail.connectUrl(user.id);
  }

  @Public()
  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    return { url: await this.gmail.finishConnect({ code, state, error }) };
  }

  @Post('sync')
  sync(@CurrentUser() user: SessionUser) {
    return this.gmail.syncNow(user.id);
  }

  @Post('suggestions/apply-all')
  applyAll(@CurrentUser() user: SessionUser) {
    return this.gmail.applyAll(user.id);
  }

  @Post('suggestions/:id/apply')
  apply(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.gmail.apply(user.id, id);
  }

  @Post('suggestions/:id/dismiss')
  dismiss(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.gmail.dismiss(user.id, id);
  }

  @Delete()
  disconnect(@CurrentUser() user: SessionUser) {
    return this.gmail.disconnect(user.id);
  }
}
