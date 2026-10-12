import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  WhatsappController,
  WhatsappAdminController,
} from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappApiService } from './whatsapp-api.service';
import { WhatsappOtpService } from './whatsapp-otp.service';
import { WhatsappOtpController } from './whatsapp-otp.controller';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { QuickMessagesService } from './quick-messages.service';
import { Order, OrderSchema } from '../../schemas/order.schema';
import {
  TribeMember,
  TribeMemberSchema,
} from '../../schemas/tribe-member.schema';
import { Tribe, TribeSchema } from '../../schemas/tribe.schema';
import {
  WhatsappOtp,
  WhatsappOtpSchema,
} from '../../schemas/whatsapp-otp.schema';
import {
  WhatsappMessage,
  WhatsappMessageSchema,
} from '../../schemas/whatsapp-message.schema';
import {
  WhatsappConversation,
  WhatsappConversationSchema,
} from '../../schemas/whatsapp-conversation.schema';
import {
  WhatsappSetting,
  WhatsappSettingSchema,
} from '../../schemas/whatsapp-setting.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WhatsappMessage.name, schema: WhatsappMessageSchema },
      { name: WhatsappConversation.name, schema: WhatsappConversationSchema },
      { name: WhatsappSetting.name, schema: WhatsappSettingSchema },
      { name: WhatsappOtp.name, schema: WhatsappOtpSchema },
      // Read only, for grouping the inbox by tribe (owner + member numbers).
      { name: TribeMember.name, schema: TribeMemberSchema },
      { name: Tribe.name, schema: TribeSchema },
      // Read only: a chat's latest order, for quick messages.
      { name: Order.name, schema: OrderSchema },
    ]),
    // Same secret as auth: OTP proof tokens are read back by the orders module.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [
    WhatsappController,
    WhatsappAdminController,
    WhatsappOtpController,
  ],
  providers: [
    WhatsappService,
    WhatsappApiService,
    WhatsappOtpService,
    WhatsappInboxService,
    QuickMessagesService,
  ],
  exports: [WhatsappService, WhatsappApiService, WhatsappOtpService],
})
export class WhatsappModule {}
