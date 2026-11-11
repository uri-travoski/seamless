import { Briefcase, House, Timer, Folder, Stack, Users, Star, Heart, ShoppingCart, Storefront, Buildings, Code } from '@phosphor-icons/react';

const GLYPHS: Record<string, any> = {
  briefcase: Briefcase, house: House, timer: Timer, folder: Folder, unified: Stack, users: Users,
  star: Star, heart: Heart, cart: ShoppingCart, store: Storefront, buildings: Buildings, code: Code,
};
export const CATEGORY_ICON_NAMES = Object.keys(GLYPHS).filter((k) => k !== 'unified');

export function CategoryGlyph({ icon, size = 16, color, className }: { icon: string; size?: number; color?: string; className?: string }) {
  const G = GLYPHS[icon] ?? Folder;
  return <G size={size} color={color} className={className} weight="duotone" />;
}
