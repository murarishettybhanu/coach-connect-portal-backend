import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { Coach } from '../../schemas/coach.schema';
import { UsersService } from '../users/users.service';
import { TransactionsService } from '../transactions/transactions.service';
import { UserRole } from '../../schemas/user.schema';

@Injectable()
export class CoachesService {
  constructor(
    @InjectModel(Coach.name) private coachModel: Model<Coach>,
    private usersService: UsersService,
    private transactionsService: TransactionsService,
  ) {}

  async create(coachData: any): Promise<Coach> {
    const existingUser = await this.usersService.findOneByEmail(coachData.email);
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    const hashedPassword = await bcrypt.hash('coach123', 10);
    const user = await this.usersService.create({
      email: coachData.email,
      name: coachData.name,
      password: hashedPassword,
      role: UserRole.COACH,
    });

    const coach = new this.coachModel({
      userId: user._id,
      username: coachData.username,
      brand: coachData.brand || coachData.name,
      walletBalance: 0,
      isActive: true,
      storefrontConfig: {},
      bankingDetails: {},
    });

    return coach.save();
  }

  async findAll(): Promise<any[]> {
    const coaches = await this.coachModel.find().populate('userId', '-password').exec();
    return Promise.all(coaches.map(async (c) => {
      const balance = await this.transactionsService.getBalance(c._id as any);
      const coachObj = c.toObject();
      return { ...coachObj, walletBalance: balance };
    }));
  }

  async findByUserId(userId: string): Promise<any> {
    const coach = await this.coachModel.findOne({ userId } as any).exec();
    if (!coach) {
      throw new NotFoundException(`Coach profile for user ${userId} not found`);
    }
    const balance = await this.transactionsService.getBalance(coach._id as any);
    const coachObj = coach.toObject();
    return { ...coachObj, walletBalance: balance };
  }

  async findOne(id: string): Promise<any> {
    const coach = await this.coachModel.findById(id).populate('userId', '-password').exec();
    if (!coach) {
      throw new NotFoundException(`Coach with ID ${id} not found`);
    }
    const balance = await this.transactionsService.getBalance(coach._id as any);
    const coachObj = coach.toObject();
    return { ...coachObj, walletBalance: balance };
  }

  async findByUsername(username: string): Promise<any> {
    const coach = await this.coachModel.findOne({ username }).exec();
    if (!coach) {
      throw new NotFoundException(`Coach with username ${username} not found`);
    }
    const balance = await this.transactionsService.getBalance(coach._id as any);
    const coachObj = coach.toObject();
    return { ...coachObj, walletBalance: balance };
  }

  async update(id: string, coachData: any): Promise<Coach> {
    const updatedCoach = await this.coachModel
      .findByIdAndUpdate(id, coachData, { new: true })
      .exec();
    if (!updatedCoach) {
      throw new NotFoundException(`Coach with ID ${id} not found`);
    }
    return updatedCoach;
  }
}
