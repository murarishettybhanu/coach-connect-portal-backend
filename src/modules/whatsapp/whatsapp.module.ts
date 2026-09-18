import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  WhatsappController,
  WhatsappAdminController,
} from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappApiService } from './whatsapp-api.service';
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
    ]),
  ],
  controllers: [WhatsappController, WhatsappAdminController],
  providers: [WhatsappService, WhatsappApiService],
  exports: [WhatsappService, WhatsappApiService],
})
export class WhatsappModule {}
