/**
 * Class tones, split out from `ClassTag` so that file only exports a component.
 *
 * Fast refresh cannot handle a module that exports both a component and a
 * helper, and a class colour is wanted in places that are not rendering a tag -
 * chart marks, borders, a dropdown row's selected tint.
 */
import { classesMap } from '@renderer/map/classMap'

/** The tone for "no class" / "all classes", shared with the mode dropdown. */
export const NEUTRAL_TONE = '#9AA0A6'

export function classTone(id: string | null | undefined): string {
  return classesMap[String(id)]?.color ?? NEUTRAL_TONE
}
