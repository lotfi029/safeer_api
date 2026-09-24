import type { BoardMember, BoardMemberGroup } from '../database/entities/board-member.entity.js';
import { toPublicAsset, type PublicMediaAsset } from '../media/public-media-asset.js';

export interface PublicBoardMember {
  id: string;
  nameAr: string;
  nameEn: string | null;
  roleAr: string;
  roleEn: string | null;
  grp: BoardMemberGroup;
  isLead: boolean;
  photoAsset: PublicMediaAsset | null;
  sortOrder: number;
}

export function toPublicBoardMember(member: BoardMember): PublicBoardMember {
  return {
    id: member.id,
    nameAr: member.nameAr,
    nameEn: member.nameEn,
    roleAr: member.roleAr,
    roleEn: member.roleEn,
    grp: member.grp,
    isLead: member.isLead,
    photoAsset: toPublicAsset(member.photoAsset),
    sortOrder: member.sortOrder,
  };
}
