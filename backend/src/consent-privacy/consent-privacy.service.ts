import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RESCUE_REPOSITORY, RescueRepository } from "../domain/rescue.repository";
import { V1Visibility } from "../domain/types";
import { hasControlledPublicPolicy } from "../category-catalog/catalog-value-validation";

@Injectable()
export class ConsentPrivacyService {
  constructor(@Inject(RESCUE_REPOSITORY) private readonly repository: RescueRepository) {}

  async setVisibility(input: {
    actorId: string;
    wardId: string;
    catalogId: string;
    visibility: V1Visibility;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void> {
    if (input.visibility !== "private" && input.visibility !== "public")
      throw new BadRequestException("V1 only permits private or public visibility");
    await this.repository.assertGuardianPermission(input.actorId, input.wardId, "public_release");
    const ward = await this.repository.getAuthorizedWard(input.actorId, input.wardId);
    if (!ward) throw new ForbiddenException("No active guardian authorization");
    const field = await this.repository.getCatalogField(input.catalogId, ward.category);
    if (!field)
      throw new NotFoundException("Catalog field is not available for this ward category");
    if (
      input.visibility === "public" &&
      (!field.approved ||
        !field.publicEligible ||
        field.maxLevel !== "public" ||
        !hasControlledPublicPolicy(field.dataType, field.validationPolicy))
    ) {
      throw new ForbiddenException("This field has not passed the public-release catalog gates");
    }
    await this.repository.setVisibility(input);
  }

  async withdrawPublicRelease(input: {
    actorId: string;
    wardId: string;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void> {
    await this.repository.assertGuardianPermission(input.actorId, input.wardId, "public_release");
    await this.repository.withdrawPublicRelease(input);
  }

  audit(actorId: string, wardId: string) {
    return this.repository.getConsentAudit(actorId, wardId);
  }
}
