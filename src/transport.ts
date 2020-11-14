import stream from 'stream';
import split from 'split2';
import pump from 'pumpify';
import through from 'through2';
import * as Sentry from '@sentry/node';

class ErrorWrapper extends Error {
  constructor(caption: string, { message, stack }: { message: string; stack: any }) {
    super(caption);
    this.name = caption;
    this.message = message;
    this.stack = stack;
  }
}

type ValueOf<T> = T extends any[] ? T[number] : T[keyof T];

const SEVERITIES_MAP = {
  10: Sentry.Severity.Debug, // pino: trace
  20: Sentry.Severity.Debug, // pino: debug
  30: Sentry.Severity.Info, // pino: info
  40: Sentry.Severity.Warning, // pino: warn
  50: Sentry.Severity.Error, // pino: error
  60: Sentry.Severity.Fatal, // pino: fatal
  trace: Sentry.Severity.Debug,
  debug: Sentry.Severity.Debug,
  info: Sentry.Severity.Info,
  warning: Sentry.Severity.Warning,
  error: Sentry.Severity.Error,
  fatal: Sentry.Severity.Fatal,
} as const;

// How severe the Severity is
const SeverityIota = {
  [Sentry.Severity.Debug]: 1,
  [Sentry.Severity.Log]: 2,
  [Sentry.Severity.Info]: 3,
  [Sentry.Severity.Warning]: 4,
  [Sentry.Severity.Error]: 5,
  [Sentry.Severity.Fatal]: 6,
  [Sentry.Severity.Critical]: 7,
} as const;

interface PinoSentryOptions extends Sentry.NodeOptions {
  /** Minimum level for a log to be reported to Sentry from pino-sentry */
  level?: keyof typeof SeverityIota;
  tagKeys?: string[];
  excludeKeys?: string[];
}

export class PinoSentryTransport {
  // Default minimum log level to `debug`
  minimumLogLevel: ValueOf<typeof SeverityIota> = SeverityIota[Sentry.Severity.Debug];
  tagKeys = [] as string[];
  excludeKeys = ['err'] as string[];

  public constructor(options?: PinoSentryOptions) {
    Sentry.init(this.validateOptions(options || {}));
  }

  public getLogSeverity(level: keyof typeof SEVERITIES_MAP): Sentry.Severity {
    return SEVERITIES_MAP[level] || Sentry.Severity.Info;
  }

  public transformer(): stream.Transform {
    return through.obj((chunk: any, _enc: any, cb: any) => {
      this.prepareAndGo(chunk, cb);
    });
  }

  public prepareAndGo(chunk: any, cb: any): void {
    const severity = this.getLogSeverity(chunk.level);

    // Check if we send this severity to Sentry
    if (this.shouldLog(severity) === false) {
      setImmediate(cb);
      return;
    }

    const scope = {
      level: severity,
      tags: Object.keys(chunk)
        .filter(key => this.tagKeys.includes(key))
        .reduce((acc, key) => ({ ...acc, [key]: chunk[key] }), {}),
      context: Object.keys(chunk)
        .filter(key => !this.excludeKeys.includes(key))
        .reduce((acc, key) => ({ ...acc, [key]: chunk[key] }), {}),
    };

    console.log(scope);

    const message = chunk['msg'];
    const err = chunk['err'];

    // Capturing Errors / Exceptions
    if (this.isSentryException(severity)) {
      if (err) {
        // Capture error messages with an `err` key
        setImmediate(() => {
          Sentry.captureException(new ErrorWrapper(message, err), scope);
          cb();
        });
      } else {
        // Capture error messages without an `err` key
        setImmediate(() => {
          Sentry.captureMessage(message, scope);
          cb();
        });
      }
    } else {
      // Capturing Messages
      setImmediate(() => {
        Sentry.captureMessage(message, scope);
        cb();
      });
    }
  }

  private validateOptions(options: PinoSentryOptions): PinoSentryOptions {
    const dsn = options.dsn || process.env.SENTRY_DSN;
    if (!dsn) {
      console.log(
        'Warning: [pino-sentry] Sentry DSN must be supplied, otherwise logs will not be reported. Pass via options or `SENTRY_DSN` environment variable.',
      );
    }
    if (options.level) {
      const allowedLevels = Object.keys(SeverityIota);
      if (allowedLevels.includes(options.level) === false) {
        throw new Error(
          `[pino-sentry] Option \`level\` must be one of: ${allowedLevels.join(
            ', ',
          )}. Received: ${options.level}`,
        );
      }
      // Set minimum log level
      this.minimumLogLevel = SeverityIota[options.level];
    }

    this.tagKeys = options.tagKeys ?? [...this.tagKeys];
    this.excludeKeys = options.excludeKeys ?? [...this.excludeKeys, 'err'];

    return {
      dsn,
      // npm_package_name will be available if ran with
      // from a "script" field in package.json.
      serverName: process.env.npm_package_name || 'pino-sentry',
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
      debug: !!process.env.SENTRY_DEBUG || false,
      sampleRate: 1.0,
      maxBreadcrumbs: 100,
      ...options,
    };
  }

  private isSentryException(level: Sentry.Severity): boolean {
    return level === Sentry.Severity.Fatal || level === Sentry.Severity.Error;
  }

  private shouldLog(severity: Sentry.Severity): boolean {
    const logLevel = SeverityIota[severity];
    return logLevel >= this.minimumLogLevel;
  }
}

export function createWriteStream(options?: PinoSentryOptions): stream.Duplex {
  const transport = new PinoSentryTransport(options);
  const sentryTransformer = transport.transformer();

  return new pump(
    split(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        // Returning undefined will not run the sentryTransformer
        return;
      }
    }),
    sentryTransformer,
  );
}

// Duplicate to not break API
export const createWriteStreamAsync = createWriteStream;
