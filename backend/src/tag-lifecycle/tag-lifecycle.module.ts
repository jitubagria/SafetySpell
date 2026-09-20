import { Module } from "@nestjs/common";
import { TagRevocationController } from "./tag-revocation.controller";
import { TagRevocationService } from "./tag-revocation.service";

/** Public access remains ScanResolver-only; company admins may revoke a specific tag. */
@Module({ controllers: [TagRevocationController], providers: [TagRevocationService] })
export class TagLifecycleModule {}
