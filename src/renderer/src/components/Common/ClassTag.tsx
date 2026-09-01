/**
 * A class, shown the way this app shows classes: a mark and a name.
 *
 * Lifted out of `ClassSelect` so the dropdown, the deck list and anything else
 * that names a class all render the same thing. The rule it carries with it is
 * the one that dropdown already established:
 *
 *   the MARK carries the colour, the NAME stays readable.
 *
 * Colouring the text as well is tempting - the class colours are pretty - but
 * it spends contrast on information the mark has already delivered, and the
 * name is the part you actually read.
 *
 * The mark used to be a plain coloured square and is now `ClassIcon`, which
 * shows the game's own emblem when it has one and falls back to that same
 * square when it does not. Nothing changes for callers: the emblem arrives on
 * its own, or it never does, and the row looks right either way.
 */
import { Box, Typography } from '@mui/material'
import type { TypographyProps } from '@mui/material'
import React from 'react'

import { classesMap } from '@renderer/map/classMap'

import ClassIcon from './ClassIcon'

export default function ClassTag({
  id,
  label,
  size = 20,
  variant = 'body2',
  tone
}: {
  id: string | null | undefined
  /** Overrides the looked-up name, for rows like 「全部職業」 that are not a class. */
  label?: string
  size?: number
  variant?: TypographyProps['variant']
  tone?: string
}): React.JSX.Element {
  return (
    <Box display="flex" alignItems="center" gap={1.25} minWidth={0}>
      {/* 20px rather than the 8px this was as a bare swatch: below about 16 the
          denser emblems (witch's mandala, nemesis's sigil) stop resolving, and
          above 20 a dropdown row starts being sized by its icon. */}
      <ClassIcon id={id} size={size} tone={tone} />
      <Typography variant={variant} noWrap>
        {label ?? classesMap[String(id)]?.label ?? id ?? '未分類'}
      </Typography>
    </Box>
  )
}
