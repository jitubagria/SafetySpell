import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { DatabaseService } from "../database/database.service";
import { ApiRole } from "../common/request-user";

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}
  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const result = await this.db.query<{
      id: string;
      role: ApiRole;
      password_hash: string;
      tenant_id: string;
    }>("SELECT id, role, password_hash, tenant_id FROM users WHERE email = $1 AND status = $2", [
      email.toLowerCase(),
      "active",
    ]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      throw new UnauthorizedException("Invalid email or password");
    return {
      accessToken: jwt.sign(
        { sub: user.id, role: user.role, tenantId: user.tenant_id },
        this.config.getOrThrow<string>("AUTH_JWT_SECRET"),
        { expiresIn: "15m" },
      ),
    };
  }
}
