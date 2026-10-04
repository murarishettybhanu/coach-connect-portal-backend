import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { Tribe } from '../../schemas/tribe.schema';
import { User } from '../../schemas/user.schema';
import { UsersService } from '../users/users.service';
import { TransactionsService } from '../transactions/transactions.service';
import { MailService } from '../mail/mail.service';
import { UserRole } from '../../schemas/user.schema';
import { generateStrongPassword } from '../../common/utils/password.util';
import { UpdateTribeDto } from './dto/update-tribe.dto';

// Tribe-document fields PATCH /tribes/:id may write (email/phone live on User).
const TRIBE_FIELDS = [
  'name',
  'username',
  'isActive',
  'brand',
  'tagline',
  'bio',
  'contactEmail',
  'profileImage',
  'logoUrl',
  'socialLinks',
  'bankingDetails',
  'storefrontConfig',
] as const;

@Injectable()
export class TribesService {
  constructor(
    @InjectModel(Tribe.name) private tribeModel: Model<Tribe>,
    // Only to undo a half-finished onboarding; UsersService has no delete.
    @InjectModel(User.name) private userModel: Model<User>,
    private usersService: UsersService,
    private transactionsService: TransactionsService,
    private mailService: MailService,
  ) {}

  async create(tribeData: any): Promise<any> {
    // Required at onboarding: the owner's number is how fulfilment reaches them
    // about orders and payouts. Enforced here too, not only in the admin form.
    if (!/^[6-9]\d{9}$/.test(String(tribeData.phoneNumber ?? ''))) {
      throw new BadRequestException(
        'A 10-digit owner phone number starting with 6-9 is required',
      );
    }

    const existingUser = await this.usersService.findOneByEmail(tribeData.email);
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }
    // Checked before the user is created, so the common failure leaves nothing
    // behind. The unique index still decides a race — handled below.
    if (!tribeData.username || (await this.tribeModel.exists({ username: tribeData.username } as any))) {
      throw new ConflictException(
        tribeData.username
          ? 'A tribe with this username already exists'
          : 'A username is required',
      );
    }

    // Strong auto-generated password — emailed to the coach; they change it after first login.
    const tempPassword = generateStrongPassword(16);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const user = await this.usersService.create({
      email: tribeData.email,
      name: tribeData.name,
      phoneNumber: tribeData.phoneNumber || undefined,
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
    let saved: Tribe;
    try {
      saved = await coach.save();
    } catch (err: any) {
      // No transactions here (standalone mongod in dev), so compensate: a
      // login without a tribe is an account that can sign in to nothing.
      await this.userModel.deleteOne({ _id: user._id } as any).exec();
      if (err?.code === 11000) {
        throw new ConflictException('A tribe with this username already exists');
      }
      throw err;
    }

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
    // One aggregation for every balance, not one ledger scan per tribe.
    const balances = await this.transactionsService.getBalances(
      coaches.map((c) => c._id),
    );
    return coaches.map((c) => ({
      ...c.toObject(),
      walletBalance: balances.get(String(c._id)) ?? 0,
    }));
  }

  /**
   * The caller's tribe id, without the balance `findByUserId` computes. For
   * ownership checks, which run on nearly every tribe request.
   */
  async findIdByUserId(userId: string): Promise<string> {
    const tribe = await this.tribeModel
      .findOne({ userId } as any)
      .select('_id')
      .lean()
      .exec();
    if (!tribe) {
      throw new NotFoundException(`Tribe profile for user ${userId} not found`);
    }
    return String(tribe._id);
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

  // PUBLIC storefront lookup — must only expose display fields. Never return
  // bankingDetails, walletBalance, or userId on this unauthenticated route.
  async findByUsername(username: string): Promise<any> {
    const tribe = await this.tribeModel
      .findOne({ username })
      .select(
        'username brand name bio tagline socialLinks contactEmail profileImage logoUrl storefrontConfig isActive',
      )
      .exec();
    if (!tribe) {
      throw new NotFoundException(`Tribe with username ${username} not found`);
    }
    return tribe;
  }

  // `tribeData` is an UpdateTribeDto already narrowed to what the caller may
  // change. The update is an explicit $set of known fields, never the raw body.
  async update(id: string, tribeData: UpdateTribeDto): Promise<Tribe> {
    const tribe = await this.tribeModel.findById(id).exec();
    if (!tribe) {
      throw new NotFoundException(`Tribe with ID ${id} not found`);
    }

    // `email` and `phoneNumber` live on the linked User (login + contact), not
    // the Tribe. `name` is mirrored to both (User is the source of truth for
    // display; Tribe.name kept in sync too).
    const { email, phoneNumber, ...tribeFields } = tribeData;
    const userPatch: { name?: string; email?: string; phoneNumber?: string } = {};
    if (tribeFields.name !== undefined) userPatch.name = tribeFields.name;
    if (email !== undefined) userPatch.email = email;
    if (phoneNumber !== undefined) userPatch.phoneNumber = phoneNumber;
    if (Object.keys(userPatch).length) {
      await this.usersService.update(String(tribe.userId), userPatch);
    }

    const $set: Record<string, unknown> = {};
    for (const key of TRIBE_FIELDS) {
      const value = (tribeFields as any)[key];
      if (value === undefined) continue;
      if (key === 'storefrontConfig' && value && typeof value === 'object') {
        // Merge, don't replace: saving the theme from the design editor must
        // not wipe the banner or domain (and vice versa). Merged here rather
        // than with dotted paths, which fail on a stored null.
        const current = (tribe.toObject() as any).storefrontConfig;
        const merged: Record<string, unknown> = {
          ...(current && typeof current === 'object' ? current : {}),
        };
        for (const [sub, v] of Object.entries(value)) {
          if (v !== undefined) merged[sub] = v;
        }
        $set.storefrontConfig = merged;
        continue;
      }
      $set[key] = value;
    }
    const updatedCoach = await this.tribeModel
      .findByIdAndUpdate(id, { $set }, { new: true })
      .exec();
    return updatedCoach as Tribe;
  }

  // Admin: reset the login password on a tribe's linked User account.
  async resetPassword(id: string, password: string): Promise<void> {
    const tribe = await this.tribeModel.findById(id).exec();
    if (!tribe) {
      throw new NotFoundException(`Tribe with ID ${id} not found`);
    }
    const hashed = await bcrypt.hash(password, 10);
    await this.usersService.updatePassword(String(tribe.userId), hashed);
  }
}
