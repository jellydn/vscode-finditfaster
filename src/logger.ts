// Credit to https://github.com/prettier/prettier-vscode/blob/main/src/LoggingService.ts#L5
import { window } from "vscode";

enum LogLevel {
	DEBUG = "DEBUG",
	INFO = "INFO",
	WARN = "WARN",
	ERROR = "ERROR",
	NONE = "NONE",
}

class Logger {
	private outputChannel = window.createOutputChannel("Find It Faster");

	private logLevel: LogLevel = LogLevel.INFO;

	public setOutputLevel(logLevel: LogLevel) {
		this.logLevel = logLevel;
	}

	/**
	 * Append messages to the output channel and format it with a title
	 *
	 * @param message The message to append to the output channel
	 */
	public debug(message: string, data?: unknown): void {
		if (
			this.logLevel === LogLevel.NONE ||
			this.logLevel === LogLevel.INFO ||
			this.logLevel === LogLevel.WARN ||
			this.logLevel === LogLevel.ERROR
		) {
			return;
		}
		this.logMessage(message, LogLevel.DEBUG);
		if (data) {
			this.logObject(data);
		}
	}

	/**
	 * Append messages to the output channel and format it with a title
	 *
	 * @param message The message to append to the output channel
	 */
	public info(message: string, data?: unknown): void {
		if (
			this.logLevel === LogLevel.NONE ||
			this.logLevel === LogLevel.WARN ||
			this.logLevel === LogLevel.ERROR
		) {
			return;
		}
		this.logMessage(message, LogLevel.INFO);
		if (data) {
			this.logObject(data);
		}
	}

	/**
	 * Append messages to the output channel and format it with a title
	 *
	 * @param message The message to append to the output channel
	 */
	public warn(message: string, data?: unknown): void {
		if (this.logLevel === LogLevel.NONE || this.logLevel === LogLevel.ERROR) {
			return;
		}
		this.logMessage(message, LogLevel.WARN);
		if (data) {
			this.logObject(data);
		}
	}

	public error(message: string, error?: unknown) {
		if (this.logLevel === LogLevel.NONE) {
			return;
		}
		this.logMessage(message, LogLevel.ERROR);
		if (typeof error === "string") {
			// Errors as a string usually only happen with
			// plugins that don't return the expected error.
			this.outputChannel.appendLine(error);
		} else if (error instanceof Error) {
			if (error?.message) {
				this.logMessage(error.message, LogLevel.ERROR);
			}
			if (error?.stack) {
				this.outputChannel.appendLine(error.stack);
			}
		} else if (error) {
			this.logObject(error);
		}
	}

	public show() {
		this.outputChannel.show();
	}

	private logObject(data: unknown): void {
		const message = JSON.stringify(data, null, 2);

		this.outputChannel.appendLine(message);
	}

	/**
	 * Append messages to the output channel and format it with a title
	 *
	 * @param message The message to append to the output channel
	 */
	private logMessage(message: string, logLevel: LogLevel): void {
		const title = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`["${logLevel}" - ${title}] ${message}`);
	}
}

export const logger = new Logger();
