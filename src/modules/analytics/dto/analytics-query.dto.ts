import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a date (YYYY-MM-DD)';

// Shape checks only; the service resolves defaults and checks the range
// (real dates, from ≤ to, ≤ 400 days) and that the ids are the caller's own.
export class AnalyticsQueryDto {
  @IsOptional()
  @Matches(DATE, { message: DATE_MESSAGE })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: DATE_MESSAGE })
  to?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: 'day' | 'week' | 'month';

  // Comma-separated ids.
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  productIds?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  kitIds?: string;
}
