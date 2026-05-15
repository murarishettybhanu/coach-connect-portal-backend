import { Document, Schema as MongooseSchema } from 'mongoose';
export declare class Product extends Document {
    coachId: MongooseSchema.Types.ObjectId;
    name: string;
    description?: string;
    baseProductionCost: number;
    retailPrice: number;
    sku: string;
    stockLevel: number;
    imageUrl?: string;
    isActive: boolean;
}
export declare const ProductSchema: MongooseSchema<Product, import("mongoose").Model<Product, any, any, any, any, any, Product>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, Product, Document<unknown, {}, Product, {
    id: string;
}, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
    _id: import("mongoose").Types.ObjectId;
}> & {
    __v: number;
}, "id"> & {
    id: string;
}, {
    _id?: import("mongoose").SchemaDefinitionProperty<import("mongoose").Types.ObjectId, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    coachId?: import("mongoose").SchemaDefinitionProperty<MongooseSchema.Types.ObjectId, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    name?: import("mongoose").SchemaDefinitionProperty<string, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    description?: import("mongoose").SchemaDefinitionProperty<string | undefined, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    baseProductionCost?: import("mongoose").SchemaDefinitionProperty<number, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    retailPrice?: import("mongoose").SchemaDefinitionProperty<number, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    sku?: import("mongoose").SchemaDefinitionProperty<string, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    stockLevel?: import("mongoose").SchemaDefinitionProperty<number, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    imageUrl?: import("mongoose").SchemaDefinitionProperty<string | undefined, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
    isActive?: import("mongoose").SchemaDefinitionProperty<boolean, Product, Document<unknown, {}, Product, {
        id: string;
    }, import("mongoose").DefaultSchemaOptions> & Omit<Product & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
}, Product>;
