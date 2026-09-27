import { Module } from '@nestjs/common';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { IndiaPostApiService } from './india-post-api.service';

@Module({
  controllers: [TrackingController],
  providers: [TrackingService, IndiaPostApiService],
  exports: [TrackingService, IndiaPostApiService],
})
export class TrackingModule {}
