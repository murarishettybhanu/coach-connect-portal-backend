import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TribeKit, TribeKitSchema } from '../../schemas/tribe-kit.schema';
import { TribeKitsService } from './tribe-kits.service';
import { TribeKitsController } from './tribe-kits.controller';
import { TribesModule } from '../tribes/tribes.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TribeKit.name, schema: TribeKitSchema },
    ]),
    TribesModule,
  ],
  providers: [TribeKitsService],
  controllers: [TribeKitsController],
})
export class TribeKitsModule {}
