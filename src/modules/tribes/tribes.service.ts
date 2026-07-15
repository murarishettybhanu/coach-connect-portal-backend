import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { Tribe } from '../../schemas/tribe.schema';
import { UsersService } from '../users/users.service';
import { TransactionsService } from '../transactions/transactions.service';
import { MailService } from '../mail/mail.service';
import { UserRole } from '../../schemas/user.schema';
import { generateStrongPassword } from '../../common/utils/password.util';

@Injectable()
export class TribesService {
  constructor(
    @InjectModel(Tribe.name) private tribeModel: Model<Tribe>,
    private usersService: UsersService,
    private transactionsService: TransactionsService,
    private mailService: MailService,
  ) {}

  async create(tribeData: any): Promise<any> {
    const existingUser = await this.usersService.findOneByEmail(tribeData.email);
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    // Strong auto-generated password — emailed to the coach; they change it after first login.
    const tempPassword = generateStrongPassword(16);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const user = await this.usersService.create({
      email: tribeData.email,
      name: tribeData.name,
      password: hashedPassword,
      role: UserRole.TRIBE,
    });

    const coach = new this.tribeModel({
      userId: user._id,
      username: tribeData.username,
      brand: tribeData.brand || tribeData.name,
      logoUrl: tribeData.logoUrl || undefined,
      walletBalance: 0,
      isActive: true,
      storefrontConfig: {},
      bankingDetails: {},
    });
    const saved = await coach.save();

    const emailSent = await this.mailService.sendTribeWelcome(
      tribeData.email,
      tribeData.name,
      tempPassword,
    );

    // If email couldn't be sent (e.g. SMTP not configured), return the temp
    // password so the admin can share it manually. Otherwise it's not exposed.
    return {
      ...saved.toObject(),
      emailSent,
      ...(emailSent ? {} : { tempPassword }),
    };
  }

  async findAll(): Promise<any[]> {
    const coaches = await this.tribeModel.find().populate('userId', '-password').exec();
    return Promise.all(coaches.map(async (c) => {
      const balance = await this.transactionsService.getBalance(c._id as any);
      const coachObj = c.toObject();
      return { ...coachObj, walletBalance: balance };
    }));
  }

  async findByUserId(userId: string): Promise<any> {
    const coach = await this.tribeModel.findOne({ userId } as any).exec();
    if (!coach) {
      throw new NotFoundException(`Tribe profile for user ${userId} not found`);
    }
    const balance = await this.transactionsService.getBalance(coach._id as any);
    const coachObj = coach.toObject();
    return { ...coachObj, walletBalance: balance };
  }

  async findOne(id: string): Promise<any> {
    const coach = await this.tribeModel.findById(id).populate('userId', '-password').exec();
    if (!coach) {
      throw new NotFoundException(`Tribe with ID ${id} not found`);
    }
    const balance = await this.transactionsService.getBalance(coach._id as any);
    const coachObj = coach.toObject();
    return { ...coachObj, walletBalance: balance };
  }

  async findByUsername(username: string): Promise<any> {
    const coach = await this.tribeModel.findOne({ username }).exec();
    if (!coach) {
      throw new NotFoundException(`Tribe with username ${username} not found`);
    }
    const balance = await this.transactionsService.getBalance(coach._id as any);
    const coachObj = coach.toObject();
    return { ...coachObj, walletBalance: balance };
  }

  async update(id: string, tribeData: any): Promise<Tribe> {
    const updatedCoach = await this.tribeModel
      .findByIdAndUpdate(id, tribeData, { new: true })
      .exec();
    if (!updatedCoach) {
      throw new NotFoundException(`Tribe with ID ${id} not found`);
    }
    return updatedCoach;
  }
}
