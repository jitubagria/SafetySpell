import { HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { TagCustodyService } from "../tag-custody/tag-custody.service";

/**
 * A protocol-neutral wrapper around the existing stage mover. The tap action
 * never receives a source or destination from the client: its destination is
 * the caller's active own-stage grant, and its source must already be placed.
 */
@Injectable()
export class StageTapService {
  constructor(private readonly custody: TagCustodyService) {}

  async tap(actor: AuthenticatedUser, tagCode: string): Promise<{ success: true }> {
    try {
      await this.custody.tapToBoundStage(actor, tagCode);
      return { success: true };
    } catch (error) {
      // No expected authorization, tenancy, placement, stale-stage, or hop
      // failure is distinguishable at this boundary, preventing tag-state
      // probing through the tap endpoint.
      if (error instanceof HttpException) throw new NotFoundException("Tap unavailable");
      throw error;
    }
  }
}
