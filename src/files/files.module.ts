import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { MediaModule } from '../media/media.module.js';
import { FilesController } from './files.controller.js';

@Module({
  imports: [ConfigModule, MediaModule],
  controllers: [FilesController],
})
export class FilesModule {}
