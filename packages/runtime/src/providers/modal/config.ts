import { z } from "zod";

export const modalConfigSchema = z
  .object({
    appName: z.string().min(1).default("aaspai-modal"),
    image: z.string().min(1).default("debian:bookworm-slim"),
    workdir: z.string().min(1).default("/workspace/aaspai"),
    sandboxTimeoutMs: z.number().positive().default(3_600_000),
  })
  .strict();

export type ModalProviderConfig = z.infer<typeof modalConfigSchema>;
