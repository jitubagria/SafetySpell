import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  UseGuards,
} from "@nestjs/common";
import { IsDefined, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { ConsentPrivacyService } from "../consent-privacy/consent-privacy.service";
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  AuthenticatedUser,
} from "../common/request-user";
import { WardGuardiansService } from "./ward-guardians.service";

class WriteFieldDto {
  @IsDefined() value!: unknown;
}
class SetVisibilityDto {
  @IsIn(["private", "public"]) visibility!: "private" | "public";
}
class VerifyClinicalDto {
  @IsOptional() @IsString() @MaxLength(1000) verificationNote?: string;
}
class IsUuidPipe {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
      throw new BadRequestException("Invalid UUID");
    return value;
  }
}

@Controller("v1/app/wards")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("guardian")
export class WardGuardiansController {
  constructor(
    private readonly wards: WardGuardiansService,
    private readonly consent: ConsentPrivacyService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.wards.list(user.id);
  }

  @Get(":wardId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("wardId", new IsUuidPipe()) wardId: string) {
    return this.wards.get(user.id, wardId);
  }

  @Get(":wardId/fields")
  fields(
    @CurrentUser() user: AuthenticatedUser,
    @Param("wardId", new IsUuidPipe()) wardId: string,
  ) {
    return this.wards.fields(user.id, wardId);
  }

  @Patch(":wardId/fields/:catalogId")
  async write(
    @CurrentUser() user: AuthenticatedUser,
    @Param("wardId", new IsUuidPipe()) wardId: string,
    @Param("catalogId", new IsUuidPipe()) catalogId: string,
    @Body() body: WriteFieldDto,
  ) {
    await this.wards.writeGuardianValue({ userId: user.id, wardId, catalogId, value: body.value });
    return { status: "updated", provenance: "guardian_reported" };
  }

  @Put(":wardId/fields/:catalogId/visibility")
  async visibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param("wardId", new IsUuidPipe()) wardId: string,
    @Param("catalogId", new IsUuidPipe()) catalogId: string,
    @Body() body: SetVisibilityDto,
  ) {
    await this.consent.setVisibility({
      actorId: user.id,
      wardId,
      catalogId,
      visibility: body.visibility,
      sessionMetadata: { source: "guardian_api" },
    });
    return { status: "updated", visibility: body.visibility };
  }
}

@Controller("v1/staff/wards")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("clinical_reviewer")
export class StaffVerificationController {
  constructor(private readonly wards: WardGuardiansService) {}
  @Patch(":wardId/fields/:catalogId/clinical-verification")
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param("wardId", new IsUuidPipe()) wardId: string,
    @Param("catalogId", new IsUuidPipe()) catalogId: string,
    @Body() body: VerifyClinicalDto,
  ) {
    await this.wards.verifyClinicalValue({
      wardId,
      catalogId,
      verifierId: user.id,
      verificationNote: body.verificationNote,
    });
    return { status: "verified", provenance: "clinician_verified" };
  }
}
