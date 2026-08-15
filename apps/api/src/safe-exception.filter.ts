import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

function transportStatus(exception: unknown): number | undefined {
  if (typeof exception !== "object" || exception === null || !("status" in exception)) return undefined;
  const status = (exception as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : undefined;
}

/** Prevent exception objects, request bodies, tokens, and paths from entering production logs. */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const status = transportStatus(exception);
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      response.status(status).json({ statusCode: status, message: "Request body exceeds 256 KiB." });
      return;
    }
    this.logger.error("Unhandled API failure.");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: "Internal server error." });
  }
}
