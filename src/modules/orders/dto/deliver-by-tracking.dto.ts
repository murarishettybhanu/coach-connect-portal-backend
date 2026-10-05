import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';
import { MAX_TRACKING_CODES } from '../tracking-codes';

export class DeliverByTrackingDto {
  @IsArray()
  @ArrayMinSize(1)
  // Duplicates are allowed in (they're collapsed server-side), so cap generously.
  @ArrayMaxSize(MAX_TRACKING_CODES * 2)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  codes: string[];
}
