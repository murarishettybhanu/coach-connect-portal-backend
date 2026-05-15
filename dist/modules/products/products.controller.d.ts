import { ProductsService } from './products.service';
export declare class ProductsController {
    private readonly productsService;
    constructor(productsService: ProductsService);
    create(productData: any): Promise<import("../../schemas/product.schema").Product>;
    findAll(coachId?: string): Promise<import("../../schemas/product.schema").Product[]>;
    findOne(id: string): Promise<import("../../schemas/product.schema").Product>;
    update(id: string, productData: any): Promise<import("../../schemas/product.schema").Product>;
    remove(id: string): Promise<void>;
}
