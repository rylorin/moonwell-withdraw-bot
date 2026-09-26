import pino from 'pino';
import { Console } from 'console';
import { mkdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';

interface LoggerOptionsExt {
  level?: string;
  file?: string;
  prettyConsole?: boolean;
}

class DailyRotatingFileStream {
  private filePath: string;
  private writeStream: ReturnType<typeof createWriteStream> | null = null;
  private currentDateFile: string = '';

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private getLogFilePath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dir = dirname(this.filePath);
    const fileName = `bot-${year}-${month}-${day}.log`;
    return join(dir, fileName);
  }

  private async rotate() {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }

    const targetFile = this.getLogFilePath();
    const dir = dirname(targetFile);
    await mkdir(dir, { recursive: true });
    this.writeStream = createWriteStream(targetFile, { flags: 'a' });
    this.currentDateFile = targetFile;
    this.cleanupOldLogs(dir);
  }

  private cleanupOldLogs(dir: string) {
    try {
      const files = require('fs').readdirSync(dir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('bot-') || !file.endsWith('.log')) continue;
        const filePath = join(dir, file);
        try {
          const stats = require('fs').statSync(filePath);
          const ageDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > 7) {
            require('fs').unlinkSync(filePath);
          }
        } catch {}
      }
    } catch {}
  }

  async write(data: string) {
    const targetFile = this.getLogFilePath();
    if (!this.writeStream || this.currentDateFile !== targetFile) {
      await this.rotate();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.writeStream) {
      this.writeStream.write(data + '\n');
    }
  }

  close() {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}

/**
 * Creates a logger with dual transport:
 * - Console: pretty-printed, human-readable output (INFO level and above)
 * - File: JSON lines with daily rotation (keeps 7 days, all levels including DEBUG)
 */
export function createLogger(options: LoggerOptionsExt = {}): Console {
  const {
    level = process.env.LOG_LEVEL || 'info',
    file = process.env.LOG_FILE || './logs/bot.log',
    prettyConsole = process.env.LOG_PRETTY !== 'false',
  } = options;

  const fileStream = new DailyRotatingFileStream(file);

  // Create console logger
  let consoleLogger: any;
  if (prettyConsole) {
    consoleLogger = pino(
      {
        level,
        redact: {
          paths: ['privateKey', 'wssUrl', 'readRpcUrl', 'apiKey', 'token', 'password'],
          censor: '**REDACTED**',
        },
        base: {
          pid: process.pid,
          hostname: require('os').hostname(),
        },
      },
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    );
  } else {
    consoleLogger = pino({
      level,
      redact: {
        paths: ['privateKey', 'wssUrl', 'readRpcUrl', 'apiKey', 'token', 'password'],
        censor: '**REDACTED**',
      },
      base: {
        pid: process.pid,
        hostname: require('os').hostname(),
      },
    });
  }

  // Create a pino logger for file output
  const fileLogger = pino(
    {
      level: 'trace', // Capture all levels
      redact: {
        paths: ['privateKey', 'wssUrl', 'readRpcUrl', 'apiKey', 'token', 'password'],
        censor: '**REDACTED**',
      },
      base: {
        pid: process.pid,
        hostname: require('os').hostname(),
      },
    },
    {
      // Custom write function that writes to our rotating stream
      write: (obj: any, sourceEncoding?: any, callback?: any) => {
        const line = JSON.stringify(obj);
        fileStream.write(line).catch(console.error);
        if (callback) callback(null, line.length);
      },
    } as any
  );

  return {
    log: (...args: unknown[]) => {
      const msg = args.map(arg =>
        typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      consoleLogger.info(msg);
      fileLogger.info(msg);
    },
    warn: (...args: unknown[]) => {
      const msg = args.map(arg =>
        typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      consoleLogger.warn(msg);
      fileLogger.warn(msg);
    },
    error: (...args: unknown[]) => {
      const msg = args.map(arg =>
        typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      consoleLogger.error(msg);
      fileLogger.error(msg);
    },
    debug: (...args: unknown[]) => {
      const msg = args.map(arg =>
        typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      // Debug only goes to file (not console) by default
      fileLogger.debug(msg);
    },
  } as Console;
}

export const logger = createLogger();