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
  providers: [WhatsappService, WhatsappApiService, WhatsappOtpService],
  exports: [WhatsappService, WhatsappApiService, WhatsappOtpService],
})
export class WhatsappModule {}
