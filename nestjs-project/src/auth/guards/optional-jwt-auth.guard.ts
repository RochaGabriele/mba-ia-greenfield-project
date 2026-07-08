import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Populates `request.user` when a valid bearer token is present, but always allows the request
 * through. Used on public endpoints that behave differently for the owner (e.g. GET a video:
 * public for `ready`, owner-only for drafts) without rejecting anonymous callers.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      } catch {
        // Invalid/expired token — proceed anonymously.
      }
    }

    return true;
  }
}
