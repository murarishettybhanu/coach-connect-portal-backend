import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CoachesService } from './coaches.service';
import { CoachesController } from './coaches.controller';
import { Coach, CoachSchema } from '../../schemas/coach.schema';
import { UsersModule } from '../users/users.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Coach.name, schema: CoachSchema }]),
    UsersModule,
    forwardRef(() => TransactionsModule),
  ],
  providers: [CoachesService],
  controllers: [CoachesController],
  exports: [CoachesService],
})
export class CoachesModule {}
