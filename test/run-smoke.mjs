import { createJiti } from "/home/jakob/git_projects/pi-subagent/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(import.meta.url, { jsx: false });
await jiti.import(new URL("./smoke-rpc.ts", import.meta.url).pathname);
