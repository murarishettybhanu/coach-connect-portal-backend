import { Document, Schema as MongooseSchema } from 'mongoose';
export declare class CoachProduct extends Document {
    coachId: MongooseSchema.Types.ObjectId;
    productId: MongooseSchema.Types.ObjectId;
    allocatedCost: number;
    isActive: boolean;
}
export declare const CoachProductSchema: MongooseSchema<CoachProduct, import("mongoose").Model<CoachProduct, any, any, any, any, any, CoachProduct>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, CoachProduct, Document<unknown, {}, CoachProduct, {
    id: string;
}, import("mongoose").DefaultSchemaOptions> & Omit<CoachProduct & Required<{
    _id: import("mongoose").Types.ObjectId;
}> & {
    __v: number;
}, "id"> & {
    id: string;
}, {
    _id?: import("mongoose").SchemaDefinitionProperty<import("mongoose").Types.ObjectId, CoachProduct, Document<unknown, {}, CoachProduct, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<CoachProduct & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    coachId?: import("mongoose").SchemaDefinitionProperty<MongooseSchema.Types.ObjectId, CoachProduct, Document<unknown, {}, CoachProduct, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<CoachProduct & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    productId?: import("mongoose").SchemaDefinitionProperty<MongooseSchema.Types.ObjectId, CoachProduct, Document<unknown, {}, CoachProduct, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<CoachProduct & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    allocatedCost?: import("mongoose").SchemaDefinitionProperty<number, CoachProduct, Document<unknown, {}, CoachProduct, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<CoachProduct & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    isActive?: import("mongoose").SchemaDefinitionProperty<boolean, CoachProduct, Document<unknown, {}, CoachProduct, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<CoachProduct & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
}, CoachProduct>;
