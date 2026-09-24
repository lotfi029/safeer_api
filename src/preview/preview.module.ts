import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PreviewController } from './preview.controller.js';

// TODO(phase 4+): import TypeOrmModule.forFeature([...]) for each
// previewable collection's entity, as preview.controller.ts gains
// repository injections for it.
@Module({
  imports: [ConfigModule],
  controllers: [PreviewController],
})
export class PreviewModule {}
