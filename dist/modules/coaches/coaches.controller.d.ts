import { CoachesService } from './coaches.service';
export declare class CoachesController {
    private readonly coachesService;
    constructor(coachesService: CoachesService);
    create(coachData: any): Promise<import("../../schemas/coach.schema").Coach>;
    findAll(): Promise<any[]>;
    getProfile(req: any): Promise<any>;
    findByUsername(username: string): Promise<any>;
    findOne(id: string): Promise<any>;
    update(id: string, coachData: any): Promise<import("../../schemas/coach.schema").Coach>;
}
