import { z } from "zod";

export const localConfigSchema = z
  .object({
    /** Root directory for filesystem operations (optional; defaults to cwd). */
    root: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    maxBufferBytes: z.number().int().positive().optional(),
  })
  .strict();

export type LocalProviderConfig = z.infer<typeof localConfigSchema>;
