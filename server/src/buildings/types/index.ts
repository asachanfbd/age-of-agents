import { hasBuildingType, registerBuildingType } from '../registry.ts';
import { softwareType } from './software.ts';
import { notesType } from './notes.ts';
import { seoType } from './seo.ts';
import { crmType } from './crm.ts';
import { contentStudioType } from './contentStudio.ts';

/** Registers the built-in types; Software first so it leads every list. Safe to call more than once. */
export function registerBuiltInTypes(): void {
  for (const type of [softwareType, notesType, seoType, crmType, contentStudioType]) if (!hasBuildingType(type.id)) registerBuildingType(type);
}

registerBuiltInTypes();
