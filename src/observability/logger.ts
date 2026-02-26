import pino from "pino";

const isDevelopment = process.env.NODE_ENV === "development";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
        },
      }
    : undefined,
  hooks: {
    logMethod(this: any, inputArgs: any[], method: any) {
      if (
        process.env.NODE_ENV === "test" &&
        (global as any).__TEST_LOG_COLLECTOR__
      ) {
        const [obj, msg] = inputArgs;
        const payload = typeof obj === "string" ? { msg: obj } : obj;

        // Extract context from pino instance
        let context = {};
        try {
          const symbols = Object.getOwnPropertySymbols(this);
          // @ts-ignore
          const chindingsSym = symbols.find((s) =>
            s.toString().includes("chindings"),
          );
          const chindings = chindingsSym
            ? (this as any)[chindingsSym]
            : undefined;

          if (chindings && typeof chindings === "string") {
            context = JSON.parse("{" + chindings.slice(1) + "}");
          } else if (!chindings) {
            // If no chindings symbol, check for a chindings property (older/different pino)
            const chindingsProp = (this as any).chindings;
            if (chindingsProp && typeof chindingsProp === "string") {
              context = JSON.parse("{" + chindingsProp.slice(1) + "}");
            }
          }
        } catch (e) {
          /* ignore */
        }

        (global as any).__TEST_LOG_COLLECTOR__.push({
          ...context,
          ...payload,
          level: method.name,
        });
      }
      return method.apply(this, inputArgs);
    },
  },
});

export default logger;
