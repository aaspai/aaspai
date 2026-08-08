import { z } from "zod";

export const exeDevConfigSchema = z
  .object({
    apiUrl: z.string().url().default("https://exe.dev/exec"),
    image: z.string().min(1).default("ubuntu-24.04"),
    command: z.string().min(1).default("/bin/bash"),
    sshPort: z.number().int().positive().default(22),
    timeoutMs: z.number().positive().default(60_000),
  })
  .strict();

export type ExeDevProviderConfig = z.infer<typeof exeDevConfigSchema>;
