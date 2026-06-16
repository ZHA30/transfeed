import { writeConfigJsonSchema } from "../state/config-schema.js";
import { stateFilePath } from "../state/paths.js";

await writeConfigJsonSchema();
console.log(`Wrote ${stateFilePath("config/feeds.schema.json")}`);
