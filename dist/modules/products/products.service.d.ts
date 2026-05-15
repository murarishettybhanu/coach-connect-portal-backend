import { Model } from 'mongoose';
import { Product } from '../../schemas/product.schema';
export declare class ProductsService {
    private productModel;
    constructor(productModel: Model<Product>);
    create(productData: any): Promise<Product>;
    findAll(): Promise<Product[]>;
    findByCoach(coachId: string): Promise<Product[]>;
    findOne(id: string): Promise<Product>;
    update(id: string, productData: any): Promise<Product>;
    remove(id: string): Promise<void>;
}
