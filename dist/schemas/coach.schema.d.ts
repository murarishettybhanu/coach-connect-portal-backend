import { Document, Schema as MongooseSchema } from 'mongoose';
export declare class Coach extends Document {
    userId: MongooseSchema.Types.ObjectId;
    username: string;
    name: string;
    brand: string;
    bio?: string;
    tagline?: string;
    socialLinks?: {
        instagram?: string;
        twitter?: string;
        youtube?: string;
        linkedin?: string;
    };
    contactEmail?: string;
    profileImage?: string;
    walletBalance: number;
    storefrontConfig: {
        bannerImage?: string;
        themeColor?: string;
        customDomain?: string;
    };
    bankingDetails: {
        accountHolderName?: string;
        accountNumber?: string;
        ifscCode?: string;
        bankName?: string;
    };
    isActive: boolean;
}
export declare const CoachSchema: MongooseSchema<Coach, import("mongoose").Model<Coach, any, any, any, any, any, Coach>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, Coach, Document<unknown, {}, Coach, {
    id: string;
}, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
    _id: import("mongoose").Types.ObjectId;
}> & {
    __v: number;
}, "id"> & {
    id: string;
}, {
    _id?: import("mongoose").SchemaDefinitionProperty<import("mongoose").Types.ObjectId, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    userId?: import("mongoose").SchemaDefinitionProperty<MongooseSchema.Types.ObjectId, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    username?: import("mongoose").SchemaDefinitionProperty<string, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    name?: import("mongoose").SchemaDefinitionProperty<string, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    brand?: import("mongoose").SchemaDefinitionProperty<string, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    bio?: import("mongoose").SchemaDefinitionProperty<string | undefined, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    tagline?: import("mongoose").SchemaDefinitionProperty<string | undefined, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    socialLinks?: import("mongoose").SchemaDefinitionProperty<{
        instagram?: string;
        twitter?: string;
        youtube?: string;
        linkedin?: string;
    } | undefined, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    contactEmail?: import("mongoose").SchemaDefinitionProperty<string | undefined, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    profileImage?: import("mongoose").SchemaDefinitionProperty<string | undefined, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    walletBalance?: import("mongoose").SchemaDefinitionProperty<number, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    storefrontConfig?: import("mongoose").SchemaDefinitionProperty<{
        bannerImage?: string;
        themeColor?: string;
        customDomain?: string;
    }, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    bankingDetails?: import("mongoose").SchemaDefinitionProperty<{
        accountHolderName?: string;
        accountNumber?: string;
        ifscCode?: string;
        bankName?: string;
    }, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    isActive?: import("mongoose").SchemaDefinitionProperty<boolean, Coach, Document<unknown, {}, Coach, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Coach & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
}, Coach>;
