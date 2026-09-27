import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
} from 'class-validator';
import { MAX_ARTICLES_PER_CALL } from '../india-post-api.service';

export class TrackBulkDto {
  // India Post accepts up to 500 article numbers per call; we cap at the same
  // number rather than silently chunking a huge request from a client.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_ARTICLES_PER_CALL)
  @IsString({ each: true })
  consignmentNumbers: string[];
}
