import { z } from "zod";
import {
  correlationIdSchema,
  identifierSchema,
  isoTimestampSchema,
  type JsonValue,
  jsonValueSchema,
  positiveIntegerSchema,
} from "./primitives";

export const eventTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/);

export const eventSourceSchema = z
  .object({
    module: identifierSchema,
    systemDefinitionId: identifierSchema.optional(),
    systemInstanceId: identifierSchema.optional(),
    connectionId: identifierSchema.optional(),
  })
  .strict();

export const eventSubjectSchema = z
  .object({
    type: identifierSchema,
    id: identifierSchema,
  })
  .strict();

export const aaspaiEventSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    type: eventTypeSchema,
    version: positiveIntegerSchema,
    source: eventSourceSchema,
    subject: eventSubjectSchema.optional(),
    actorId: identifierSchema.optional(),
    correlationId: correlationIdSchema,
    causationId: identifierSchema.optional(),
    occurredAt: isoTimestampSchema,
    receivedAt: isoTimestampSchema,
    data: jsonValueSchema,
  })
  .strict();

export type AaspaiEvent<T extends JsonValue = JsonValue> = Omit<
  z.infer<typeof aaspaiEventSchema>,
  "data"
> & {
  data: T;
};

export function createAaspaiEvent<T extends JsonValue>(input: {
  id: string;
  organizationId: string;
  type: string;
  version?: number;
  source: z.infer<typeof eventSourceSchema>;
  subject?: z.infer<typeof eventSubjectSchema>;
  actorId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: string;
  receivedAt?: string;
  data: T;
}): AaspaiEvent<T> {
  return aaspaiEventSchema.parse({
    ...input,
    type: eventTypeSchema.parse(input.type),
    version: input.version ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  }) as AaspaiEvent<T>;
}

export function createAaspaiEventSchema<T extends z.ZodType<JsonValue>>(dataSchema: T) {
  return aaspaiEventSchema.extend({ data: dataSchema }).strict();
}
