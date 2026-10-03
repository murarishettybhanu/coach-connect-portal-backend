import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { userIdOf } from '../utils/ownership';

/** The signed-in user's id as a string (see `userIdOf`). */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    userIdOf(ctx.switchToHttp().getRequest().user),
);
