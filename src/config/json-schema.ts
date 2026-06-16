import { toJSONSchema } from "zod";
import { rawConfigSchema } from "./schema.js";

export function makeConfigJsonSchema(): Record<string, unknown> {
  const schema = toJSONSchema(rawConfigSchema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;

  return {
    ...schema,
    $id: "feeds.schema.json",
    title: "Feed configuration",
    description: "Configuration for feed feature generation.",
  };
}
