import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TribesService } from '../tribes/tribes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../schemas/user.schema';
import { CreatePayoutDto } from './dto/create-payout.dto';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly tribesService: TribesService,
  ) {}

  @Get('me')
  @Roles(UserRole.TRIBE)
  async findMyTransactions(@CurrentUserId() userId: string) {
    const tribeId = await this.tribesService.findIdByUserId(userId);
    return this.transactionsService.findByCoach(tribeId);
  }

  @Get('my-balance')
  @Roles(UserRole.TRIBE)
  async getMyBalance(@CurrentUserId() userId: string) {
    const tribeId = await this.tribesService.findIdByUserId(userId);
    const balance = await this.transactionsService.getBalance(tribeId);
    return { balance };
  }

  @Post('payout')
  @Roles(UserRole.ADMIN)
  createPayout(@Body() dto: CreatePayoutDto) {
    return this.transactionsService.createPayout(dto);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.transactionsService.findAll();
  }

  @Get('tribe')
  @Roles(UserRole.TRIBE)
  findByCoach(@CurrentUserId() userId: string) {
    return this.findMyTransactions(userId);
  }

  @Get('balance')
  @Roles(UserRole.TRIBE)
  async getBalance(@CurrentUserId() userId: string) {
    return this.getMyBalance(userId);
  }
}
