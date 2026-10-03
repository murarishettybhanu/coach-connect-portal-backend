import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TribesService } from './tribes.service';
import { TribesController } from './tribes.controller';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tribe.name, schema: TribeSchema },
      // Read/delete only: rolls back the login if onboarding fails half way.
      { name: User.name, schema: UserSchema },
    ]),
    UsersModule,
    forwardRef(() => TransactionsModule),
    MailModule,
  ],
  providers: [TribesService],
  controllers: [TribesController],
  exports: [TribesService],
})
export class TribesModule {}
