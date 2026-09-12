import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { RESCUE_REPOSITORY, RescueRepository } from "../domain/rescue.repository";
import {
  sanitizeCatalogValue,
  validateCatalogValue,
} from "../category-catalog/catalog-value-validation";

@Injectable()
export class WardGuardiansService {
  constructor(@Inject(RESCUE_REPOSITORY) private readonly repository: RescueRepository) {}
  list(userId: string) {
    return this.repository.listAuthorizedWards(userId);
  }
  async get(userId: string, wardId: string) {
    const ward = await this.repository.getAuthorizedWard(userId, wardId);
    if (!ward) throw new NotFoundException("Ward not found");
    return ward;
  }
  async fields(userId: string, wardId: string) {
    return this.repository.getAuthorizedFields(userId, wardId);
  }
  async tags(userId: string, wardId: string) {
    const ward = await this.repository.getAuthorizedWard(userId, wardId);
    if (!ward) throw new NotFoundException("Ward not found");
    return this.repository.listAuthorizedWardTags(userId, wardId);
  }
  async writeGuardianValue(input: {
    userId: string;
    wardId: string;
    catalogId: string;
    value: unknown;
  }): Promise<void> {
    await this.repository.assertGuardianPermission(input.userId, input.wardId, "fields");
    const ward = await this.repository.getAuthorizedWard(input.userId, input.wardId);
    if (!ward) throw new ForbiddenException("No active guardian authorization");
    const field = await this.repository.getCatalogField(input.catalogId, ward.category);
    if (!field) throw new NotFoundException("Catalog field unavailable");
    // Free-text values pass the server-side safety lock (HTML stripped, links neutralised,
    // plain text, length-capped) before validation and storage.
    const value = sanitizeCatalogValue(field.dataType, field.validationPolicy, input.value);
    validateCatalogValue(field.dataType, field.validationPolicy, value);
    await this.repository.upsertGuardianValue({
      wardId: input.wardId,
      catalogId: input.catalogId,
      value,
      actorId: input.userId,
    });
  }
}
