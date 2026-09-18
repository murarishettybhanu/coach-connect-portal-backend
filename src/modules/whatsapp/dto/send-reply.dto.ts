import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendReplyDto {
  // WhatsApp caps a text body at 4096 characters.
  @IsNotEmpty()
  @IsString()
  @MaxLength(4096, {
    message: 'A WhatsApp message cannot exceed 4096 characters',
  })
  text: string;
}
