import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CoachesService } from '../coaches/coaches.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly coachesService: CoachesService,
  ) {}

  @Get('me')
  @Roles(UserRole.COACH)
  async findMyTransactions(@Request() req) {
    const coach = await this.coachesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
    return this.transactionsService.findByCoach(coach._id);
  }

  @Get('my-balance')
  @Roles(UserRole.COACH)
  async getMyBalance(@Request() req) {
    const coach = await this.coachesService.findByUserId(req.user.userId || req.user.sub || req.user._id);
    const balance = await this.transactionsService.getBalance(coach._id);
    return { balance };
  }

  @Post('payout')
  @Roles(UserRole.ADMIN)
  createPayout(@Body() payoutData: any) {
    return this.transactionsService.create({
      ...payoutData,
      type: 'PAYOUT',
    });
  }

  @Get()
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.transactionsService.findAll();
  }

  @Get('coach')
  @Roles(UserRole.COACH)
  findByCoach(@Request() req) {
    return this.findMyTransactions(req);
  }

  @Get('balance')
  @Roles(UserRole.COACH)
  async getBalance(@Request() req) {
    return this.getMyBalance(req);
  }
}
