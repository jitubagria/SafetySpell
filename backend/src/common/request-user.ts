import {
  SetMetadata,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  CanActivate,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import * as jwt from "jsonwebtoken";

export type ApiRole = "company_admin" | "guardian" | "staff" | "distributor";
export interface AuthenticatedUser {
  id: string;
  role: ApiRole;
}
export interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  ip?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) throw new UnauthorizedException();
    return request.user;
  },
);
export const ROLES_KEY = "roles";
export const Roles = (...roles: ApiRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("Authentication is required");
    try {
      const payload = jwt.verify(token, this.config.getOrThrow<string>("AUTH_JWT_SECRET")) as {
        sub: string;
        role: ApiRole;
      };
      request.user = { id: payload.sub, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid authentication token");
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ApiRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user || !required.includes(user.role)) throw new ForbiddenException("Insufficient role");
    return true;
  }
}
