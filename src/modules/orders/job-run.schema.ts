import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * One row per scheduled-job window that has been claimed, so a window is sent
 * once even if the cron fires twice (two replicas during a rolling deploy, or
 * a restart that re-triggers it). Claimed with an upsert on (job, windowEnd)
 * before anything is sent.
 */
@Schema({ timestamps: true, collection: 'job_runs' })
export class JobRun extends Document {
  @Prop({ required: true })
  job: string;

  @Prop({ required: true })
  windowStart: Date;

  @Prop({ required: true })
  windowEnd: Date;
}

export const JobRunSchema = SchemaFactory.createForClass(JobRun);

JobRunSchema.index({ job: 1, windowEnd: 1 }, { unique: true });

/**
 * Claims a job window. True only for the first caller; a second run of the
 * same window (or one racing it) gets false and should skip.
 */
export async function claimJobWindow(
  model: { updateOne: (...args: any[]) => any } | undefined,
  job: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  // No model wired (unit tests construct the services bare): don't gate.
  if (!model) return true;
  try {
    const res = await model
      .updateOne(
        { job, windowEnd },
        { $setOnInsert: { job, windowStart, windowEnd } },
        { upsert: true },
      )
      .exec();
    return (res?.upsertedCount ?? 0) > 0;
  } catch (err: any) {
    // Two runs upserting at the same instant: the loser hits the unique index.
    if (err?.code === 11000) return false;
    throw err;
  }
}
