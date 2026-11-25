import { Module } from '@nestjs/common';
import { PermissionsController, RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

/** PERM-4: the role catalog and roles CRUD. RolesService is exported for the users screens' role picker and assignment checks. */
@Module({
  controllers: [PermissionsController, RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
