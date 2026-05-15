import { Model } from 'mongoose';
import { CoachProduct } from './schemas/coach-product.schema';
export declare class CoachProductsService {
    private coachProductModel;
    constructor(coachProductModel: Model<CoachProduct>);
    allot(data: any): Promise<CoachProduct>;
    findByCoach(coachId: string): Promise<CoachProduct[]>;
    remove(id: string): Promise<void>;
}
