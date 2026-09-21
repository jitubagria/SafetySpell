import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

export class CreateRouteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

export class UpdateRouteDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsUUID()
  startStageId?: string;
}

export class CreateStageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

export class UpdateStageDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateHopDto {
  @IsUUID()
  @IsNotEmpty()
  fromStageId!: string;

  @IsUUID()
  @IsNotEmpty()
  toStageId!: string;

  @IsUUID()
  @IsNotEmpty()
  allowedTenantRoleId!: string;
}

export class UpdateHopDto {
  @IsBoolean()
  active!: boolean;
}

export class CreateTenantRoleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsIn(["unprivileged", "operational_staff", "guardian", "admin"])
  authorityClass!: "unprivileged" | "operational_staff" | "guardian" | "admin";
}

export class UpdateTenantRoleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AssignUserTenantRoleDto {
  @IsOptional()
  @IsUUID()
  tenantRoleId?: string | null;
}
