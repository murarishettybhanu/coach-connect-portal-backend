import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OrdersService } from './orders.service';
import { DispatchDigestService } from './dispatch-digest.service';
import { WeeklyReportService } from './weekly-report.service';
import { OrdersController } from './orders.controller';
import { Order, OrderSchema } from '../../schemas/order.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { TribeKit, TribeKitSchema } from '../../schemas/tribe-kit.schema';
import { JobRun, JobRunSchema } from './job-run.schema';
import { ProductsModule } from '../products/products.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { TribesModule } from '../tribes/tribes.module';
import { BarcodesModule } from '../barcodes/barcodes.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Campaign.name, schema: CampaignSchema },
      // Read-only: a kit-linked store sale is priced from its kit.
      { name: TribeKit.name, schema: TribeKitSchema },
      // Once-per-window guard for the scheduled WhatsApp jobs.
      { name: JobRun.name, schema: JobRunSchema },
    ]),
    ProductsModule,
    TransactionsModule,
    TribesModule,
    BarcodesModule,
    WhatsappModule,
    // Resolves the user behind a bearer token on the public write routes.
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [OrdersService, DispatchDigestService, WeeklyReportService],
  controllers: [OrdersController],
  exports: [OrdersService, DispatchDigestService, WeeklyReportService],
})
export class OrdersModule {}
