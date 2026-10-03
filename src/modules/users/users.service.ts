import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../../schemas/user.schema';

/** Emails are compared and stored trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  async create(userData: Partial<User>): Promise<User> {
    const newUser = new this.userModel({
      ...userData,
      ...(userData.email !== undefined
        ? { email: normalizeEmail(userData.email) }
        : {}),
    });
    return newUser.save();
  }

  /**
   * Looks a user up by email, ignoring case. New accounts are stored
   * lowercased, so the exact match normally hits; accounts created before
   * that may still hold mixed case, hence the case-insensitive fallback
   * (anchored, with the input escaped, so it matches that one address only).
   */
  async findOneByEmail(email: string): Promise<User | null> {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const exact = await this.userModel
      .findOne({ email: normalized } as any)
      .exec();
    if (exact) return exact;
    return this.userModel
      .findOne({
        email: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' },
      } as any)
      .exec();
  }

  async findOneById(id: string): Promise<User | null> {
    return this.userModel.findById(id).exec();
  }

  // Also bumps tokenVersion, so every session issued before the change stops
  // working — both the user's own change and an admin reset go through here.
  async updatePassword(id: string, hashedPassword: string): Promise<void> {
    await this.userModel
      .findByIdAndUpdate(id, {
        $set: { password: hashedPassword },
        $inc: { tokenVersion: 1 },
      })
      .exec();
  }

  // Update a user's name, email and/or phone (email is unique — reject collisions).
  // The patch is built field by field, so anything new has to be named here.
  async update(
    id: string,
    data: { name?: string; email?: string; phoneNumber?: string },
  ): Promise<void> {
    const patch: any = {};
    if (data.name !== undefined) patch.name = data.name;
    // An empty string is a deliberate "clear it", so only `undefined` is skipped.
    if (data.phoneNumber !== undefined) patch.phoneNumber = data.phoneNumber;
    if (data.email !== undefined) {
      const email = normalizeEmail(data.email);
      const existing = await this.findOneByEmail(email);
      if (existing && String(existing._id) !== String(id)) {
        throw new ConflictException('A user with this email already exists');
      }
      patch.email = email;
    }
    if (Object.keys(patch).length) {
      await this.userModel.findByIdAndUpdate(id, { $set: patch }).exec();
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
