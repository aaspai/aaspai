import { z } from "zod";

export const cloudflareConfigSchema = z
  .object({
    bridgeUrl: z.string().url().optional(),
    authToken: z.string().optional(),
  })
  .strict();

export type CloudflareProviderConfig = z.infer<typeof cloudflareConfigSchema>;
