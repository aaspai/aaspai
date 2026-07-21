import { z } from "zod";
import {
  correlationIdSchema,
  idempotencyKeySchema,
  identifierSchema,
  jsonObjectSchema,
} from "./primitives";

export const apiErrorSchema = z
  .object({
    code: identifierSchema,
    message: z.string().trim().min(1),
    requestId: identifierSchema,
    details: jsonObjectSchema.optional(),
    retryable: z.boolean(),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

export const idempotencyContextSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    correlationId: correlationIdSchema,
    causationId: identifierSchema.optional(),
  })
  .strict();

export type IdempotencyContext = z.infer<typeof idempotencyContextSchema>;
