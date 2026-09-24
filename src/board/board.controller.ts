import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { CacheInterceptor } from '../cache/cache.interceptor.js';
import { CacheTags } from '../cache/cache-tags.decorator.js';
import { CacheKeyParams } from '../cache/cache-key-params.decorator.js';
import { BoardMember, type BoardMemberGroup } from '../database/entities/board-member.entity.js';
import { toPublicBoardMember, type PublicBoardMember } from './public-board-member.js';

const GROUPS: BoardMemberGroup[] = ['board', 'executive'];

@Controller('board')
@SkipThrottle()
export class BoardController {
  constructor(@InjectRepository(BoardMember) private readonly repo: Repository<BoardMember>) {}

  @Public()
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTags('board_members')
  @CacheKeyParams()
  async list(): Promise<Record<BoardMemberGroup, PublicBoardMember[]>> {
    const members = await this.repo.find({
      where: { isPublished: true },
      order: { sortOrder: 'ASC' },
      relations: { photoAsset: true },
    });
    const grouped = Object.fromEntries(GROUPS.map((g) => [g, [] as PublicBoardMember[]])) as Record<BoardMemberGroup, PublicBoardMember[]>;
    for (const member of members) {
      grouped[member.grp].push(toPublicBoardMember(member));
    }
    return grouped;
  }
}
