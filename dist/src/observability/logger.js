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
});
export default logger;
//# sourceMappingURL=logger.js.map