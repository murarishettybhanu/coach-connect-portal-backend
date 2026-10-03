import { ArrayMaxSize, IsArray, IsMongoId } from 'class-validator';

// Each order's media is fetched server-side, so the batch is bounded.
export const MAX_MEDIA_ORDERS = 200;

export class DownloadMediaDto {
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ORDERS)
  @IsMongoId({ each: true })
  orderIds: string[];
}
