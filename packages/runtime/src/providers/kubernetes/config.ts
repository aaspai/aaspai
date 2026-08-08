import { z } from "zod";

export const kubernetesConfigSchema = z
  .object({
    namespace: z.string().min(1).default("default"),
    image: z.string().min(1).default("alpine:3.20"),
    timeoutMs: z.number().positive().default(60_000),
    kubectl: z.string().min(1).default("kubectl"),
  })
  .strict();

export type KubernetesProviderConfig = z.infer<typeof kubernetesConfigSchema>;
