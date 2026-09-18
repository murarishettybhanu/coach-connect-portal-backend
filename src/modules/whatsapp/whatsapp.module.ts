import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  WhatsappController,
  WhatsappMessagesController,
} from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import {
  WhatsappMessage,
  WhatsappMessageSchema,
} from '../../schemas/whatsapp-message.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WhatsappMessage.name, schema: WhatsappMessageSchema },
    ]),
  ],
  controllers: [WhatsappController, WhatsappMessagesController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
