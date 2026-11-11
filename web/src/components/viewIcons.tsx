import { MagnifyingGlass, Star, Hourglass, Warning, Paperclip, Receipt, EnvelopeSimple, Tag } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

const MAP: Record<string, Icon> = {
  'magnifying-glass': MagnifyingGlass, star: Star, hourglass: Hourglass, warning: Warning,
  paperclip: Paperclip, receipt: Receipt, 'envelope-simple': EnvelopeSimple, tag: Tag,
};

export function ViewGlyph({ icon, className }: { icon: string; className?: string }) {
  const Icon = MAP[icon] ?? MagnifyingGlass;
  return <Icon className={className} />;
}
