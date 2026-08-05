import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default('')
});

export const CtxContextSchema = z.object({
  task: TaskSchema
}).catchall(z.unknown());

export const HostContextSchema = z.object({
  abortSignal: z.instanceof(AbortSignal).optional()
}).catchall(z.unknown());
