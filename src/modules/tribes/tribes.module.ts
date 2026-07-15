import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TribesService } from './tribes.service';
import { TribesController } from './tribes.controller';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { UsersModule } from '../users/users.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Tribe.name, schema: TribeSchema }]),
    UsersModule,
    forwardRef(() => TransactionsModule),
    MailModule,
  ],
  providers: [TribesService],
  controllers: [TribesController],
  exports: [TribesService],
})
export class TribesModule {}
