import { CoachProductsService } from './coach-products.service';
export declare class CoachProductsController {
    private readonly coachProductsService;
    constructor(coachProductsService: CoachProductsService);
    allot(data: any): Promise<import("./schemas/coach-product.schema").CoachProduct>;
    findByCoach(coachId: string): Promise<import("./schemas/coach-product.schema").CoachProduct[]>;
    remove(id: string): Promise<void>;
}
