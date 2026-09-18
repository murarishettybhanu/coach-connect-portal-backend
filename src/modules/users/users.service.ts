import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../../schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  async create(userData: Partial<User>): Promise<User> {
    const newUser = new this.userModel(userData);
    return newUser.save();
  }

  async findOneByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email } as any).exec();
  }

  async findOneById(id: string): Promise<User | null> {
    return this.userModel.findById(id).exec();
  }

  async updatePassword(id: string, hashedPassword: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(id, { password: hashedPassword }).exec();
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
      const existing = await this.userModel.findOne({ email: data.email } as any).exec();
      if (existing && String(existing._id) !== String(id)) {
        throw new ConflictException('A user with this email already exists');
      }
      patch.email = data.email;
    }
    if (Object.keys(patch).length) {
      await this.userModel.findByIdAndUpdate(id, patch).exec();
    }
  }
}
