import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default('')
});

export const CtxContextSchema = z.object({
  secrets: z.record(z.string(), z.string().optional()).optional().default({}),
  task: TaskSchema
}).catchall(z.unknown());
