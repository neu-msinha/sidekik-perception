import { startPerception } from "./app.js";
import { loadPerceptionEnv } from "./env.js";

const env = loadPerceptionEnv();
const perception = await startPerception(env);
perception.log.info({ port: env.PORT }, "perception listening");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    perception.log.info({ signal }, "shutting down");
    perception
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        perception.log.error({ err }, "shutdown failed");
        process.exit(1);
      });
  });
}
