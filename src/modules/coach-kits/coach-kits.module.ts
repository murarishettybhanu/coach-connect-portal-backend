import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CoachKit, CoachKitSchema } from '../../schemas/coach-kit.schema';
import { CoachKitsService } from './coach-kits.service';
import { CoachKitsController } from './coach-kits.controller';
import { CoachesModule } from '../coaches/coaches.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CoachKit.name, schema: CoachKitSchema },
    ]),
    CoachesModule,
  ],
  providers: [CoachKitsService],
  controllers: [CoachKitsController],
})
export class CoachKitsModule {}
