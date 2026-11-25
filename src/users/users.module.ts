import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from '../database/entities/role.entity.js';
import { User } from '../database/entities/user.entity.js';
import { Session } from '../database/entities/session.entity.js';
import { RolesModule } from '../roles/roles.module.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([User, Role, Session]), RolesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
