import { z } from "zod";

export const sshConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive().default(22),
    username: z.string().min(1).default("root"),
    privateKey: z.string().min(1).optional(),
    remoteCwd: z.string().min(1).default("/tmp/aaspai"),
    strictHostKeyChecking: z.boolean().default(true),
    knownHosts: z.string().optional(),
    shellCommand: z.enum(["bash", "sh"]).default("bash"),
  })
  .strict();

export type SshProviderConfig = z.infer<typeof sshConfigSchema>;
