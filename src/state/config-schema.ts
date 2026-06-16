import { makeConfigJsonSchema } from "../config/json-schema.js";
import { writeJsonFile } from "../lib/files.js";
import { stateFilePath } from "./paths.js";

export async function writeConfigJsonSchema(path = stateFilePath("config/feeds.schema.json")): Promise<void> {
  await writeJsonFile(path, makeConfigJsonSchema());
}
