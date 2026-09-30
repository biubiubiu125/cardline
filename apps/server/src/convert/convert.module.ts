import { Global, Module } from '@nestjs/common';
import { MailboxModule } from '../mailbox/mailbox.module';
import { ConvertService } from './convert.service';
import { TokenRefreshClient } from './token-refresh';

@Global()
@Module({
  imports: [MailboxModule],
  providers: [ConvertService, TokenRefreshClient],
  exports: [ConvertService, TokenRefreshClient],
})
export class ConvertModule {}
