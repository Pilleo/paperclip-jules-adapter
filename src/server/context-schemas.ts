import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional().default('Jules Task'),
  description: z.string().optional().default('')
});

export const ResolvedInteractionSchema = z.object({
  interactionId: z.string().optional(),
  questionId: z.string().optional(),
  answer: z.string().optional(),
  text: z.string().optional(),
  approved: z.boolean().optional(),
  reason: z.string().optional()
});

export const CtxContextSchema = z.object({
  secrets: z.record(z.string(), z.string().optional()).optional().default({}),
  task: TaskSchema.optional()
}).catchall(z.unknown());
