import { Transform } from 'class-transformer';
import { titleCaseName } from '../utils/name.util';

/**
 * Stores a person's name title-cased ("RAVI kumar" → "Ravi Kumar"), however
 * it was typed or imported. Runs before validation (the global ValidationPipe
 * transforms), so a whitespace-only name collapses to "" and still fails
 * `@IsNotEmpty`. Non-strings pass through for the type validators to reject.
 */
export const TitleCaseName = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? titleCaseName(value) : value,
  );
