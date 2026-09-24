import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from "@nestjs/common";
import { Observable, TimeoutError, catchError, throwError, timeout } from "rxjs";

@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(5_000),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new RequestTimeoutException("Verification timed out")
            : error,
        ),
      ),
    );
  }
}
