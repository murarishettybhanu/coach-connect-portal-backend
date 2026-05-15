import { Document, Schema as MongooseSchema } from 'mongoose';
export declare enum CampaignType {
    WELCOME_KIT = "WELCOME_KIT",
    STORE_SALE = "STORE_SALE"
}
export declare class Campaign extends Document {
    coachId: MongooseSchema.Types.ObjectId;
    name: string;
    type: CampaignType;
    products: {
        productId: MongooseSchema.Types.ObjectId;
        retailPrice?: number;
    }[];
    slug: string;
    isActive: boolean;
    description?: string;
    claims: number;
}
export declare const CampaignSchema: MongooseSchema<Campaign, import("mongoose").Model<Campaign, any, any, any, any, any, Campaign>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, Campaign, Document<unknown, {}, Campaign, {
    id: string;
}, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
    _id: import("mongoose").Types.ObjectId;
}> & {
    __v: number;
}, "id"> & {
    id: string;
}, {
    _id?: import("mongoose").SchemaDefinitionProperty<import("mongoose").Types.ObjectId, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    type?: import("mongoose").SchemaDefinitionProperty<CampaignType, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    coachId?: import("mongoose").SchemaDefinitionProperty<MongooseSchema.Types.ObjectId, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    name?: import("mongoose").SchemaDefinitionProperty<string, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    products?: import("mongoose").SchemaDefinitionProperty<{
        productId: MongooseSchema.Types.ObjectId;
        retailPrice?: number;
    }[], Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    slug?: import("mongoose").SchemaDefinitionProperty<string, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    isActive?: import("mongoose").SchemaDefinitionProperty<boolean, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    description?: import("mongoose").SchemaDefinitionProperty<string | undefined, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    claims?: import("mongoose").SchemaDefinitionProperty<number, Campaign, Document<unknown, {}, Campaign, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Campaign & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
}, Campaign>;
