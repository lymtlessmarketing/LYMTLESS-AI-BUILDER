import { z } from "zod";

export const appBlueprintSchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
  appType: z.enum(["website", "web_app", "internal_tool", "saas"]),
  pages: z.array(z.object({
    name: z.string(),
    route: z.string(),
    purpose: z.string(),
  })).min(1),
  entities: z.array(z.object({
    name: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.enum(["text", "number", "boolean", "date", "timestamp", "uuid", "json"]),
      required: z.boolean(),
    })),
  })),
  roles: z.array(z.object({
    name: z.string(),
    permissions: z.array(z.string()),
  })),
  integrations: z.array(z.string()),
  features: z.array(z.string()),
  designDirection: z.object({
    style: z.string(),
    primaryColor: z.string(),
    density: z.enum(["compact", "balanced", "spacious"]),
  }),
});

export type AppBlueprint = z.infer<typeof appBlueprintSchema>;
