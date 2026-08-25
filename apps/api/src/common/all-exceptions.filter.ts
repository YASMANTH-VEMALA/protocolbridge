import type {
  ArgumentsHost} from "@nestjs/common";
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";

interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;

    let payload: ErrorPayload;
    if (typeof raw === "object" && raw !== null && "code" in raw && "message" in raw) {
      const typed = raw as { code: unknown; message: unknown; issues?: unknown };
      payload = {
        code: String(typed.code),
        message: String(typed.message),
        ...(typed.issues === undefined ? {} : { details: typed.issues }),
      };
    } else if (typeof raw === "string") {
      payload = { code: "HTTP_ERROR", message: raw };
    } else {
      payload = {
        code: status === 500 ? "INTERNAL_ERROR" : "HTTP_ERROR",
        message: status === 500 ? "An unexpected error occurred." : "Request failed.",
      };
    }

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(status).json({ error: payload });
  }
}
