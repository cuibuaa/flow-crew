import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const stdoutDestination: DestinationStream = {
  write(message: string): void {
    process.stdout.write(message);
  },
};

let activeDestination: DestinationStream = stdoutDestination;

// Every application logger writes through this stable proxy. Commands that need a
// human-only stdout stream can temporarily redirect diagnostics without discarding
// them or having to know which scheduler modules will emit logs.
const routingDestination: DestinationStream = {
  write(message: string): void {
    activeDestination.write(message);
  },
};

export function createLogger(options: LoggerOptions): Logger {
  return pino(options, routingDestination);
}

export function routeLogsToFile(path: string): () => void {
  const previous = activeDestination;
  const destination = pino.destination({ dest: path, sync: true });
  activeDestination = destination;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    activeDestination = previous;
    destination.flushSync();
    destination.end();
  };
}
