import { Body, Controller, Post } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service";
class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
}
@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post("login") login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }
}
