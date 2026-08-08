import { z } from "zod";

export const dockerConfigSchema = z
  .object({
    command: z.string().min(1).default("docker"),
    cleanupRetries: z.number().int().positive().default(3),
    network: z.enum(["none", "bridge", "host"]).default("bridge"),
    defaultImage: z.string().min(1).default("node:22-bookworm-slim"),
    memoryMb: z.number().int().positive().optional(),
    cpuShares: z.number().int().positive().optional(),
  })
  .strict();

export type DockerProviderConfig = z.infer<typeof dockerConfigSchema>;
