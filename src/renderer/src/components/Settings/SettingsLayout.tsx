import { Box, Paper, Typography } from '@mui/material'
import React from 'react'
import { PANEL_SX } from '../Common/surfaces'
import IOSSwitch from '../Common/IOSSwitch'

/**
 * The settings page's building blocks, in the layout current desktop apps use:
 * a small section label, then one card of rows, each row a name (with an
 * optional one-line explanation) on the left and its control on the right.
 *
 * The page used to be headings and loose switches with their labels trailing
 * after them, so every control sat at a different x and nothing told you where
 * one group ended. A row puts every control in the same column and the card
 * draws the group.
 */

/** Max width of the settings column; rows wider than this are hard to scan across. */
export const SETTINGS_WIDTH = 720

export const SettingsSection: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children
}) => (
  <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    <Typography
      component="h2"
      sx={{ fontSize: 13, fontWeight: 600, color: 'text.secondary', px: 0.5, letterSpacing: 0.2 }}
    >
      {title}
    </Typography>
    <Paper
      elevation={0}
      sx={{
        ...PANEL_SX,
        borderRadius: '12px',
        overflow: 'hidden',
        // Rows are separated here rather than by a `Divider` in every caller, so
        // a section whose rows come and go (a child that renders null) never
        // shows a doubled or dangling line.
        '& > * + *': { borderTop: '1px solid rgba(255,255,255,0.06)' }
      }}
    >
      {children}
    </Paper>
  </Box>
)

export const SettingRow: React.FC<{
  title: React.ReactNode
  /** One line under the title. Longer explanations belong in an `InfoHint`. */
  description?: React.ReactNode
  /** Sits right after the title, e.g. an `InfoHint`. */
  adornment?: React.ReactNode
  control?: React.ReactNode
  disabled?: boolean
  /** Render as a `<label>`, so a click anywhere on the row reaches the control. */
  asLabel?: boolean
}> = ({ title, description, adornment, control, disabled, asLabel }) => (
  <Box
    component={asLabel ? 'label' : 'div'}
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      px: 2,
      py: 1.25,
      minHeight: 56,
      cursor: asLabel && !disabled ? 'pointer' : undefined,
      opacity: disabled ? 0.5 : 1,
      transition: 'opacity 150ms'
    }}
  >
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography component="span" sx={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>
          {title}
        </Typography>
        {adornment}
      </Box>
      {description && (
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.45, mt: 0.25 }}>
          {description}
        </Typography>
      )}
    </Box>
    {control && <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{control}</Box>}
  </Box>
)

export const SwitchRow: React.FC<{
  title: string
  description?: React.ReactNode
  adornment?: React.ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}> = ({ title, description, adornment, checked, disabled, onChange }) => (
  <SettingRow
    asLabel
    title={title}
    description={description}
    adornment={adornment}
    disabled={disabled}
    control={
      <IOSSwitch
        checked={checked}
        disabled={disabled}
        onChange={(_, value) => onChange(value)}
        slotProps={{ input: { 'aria-label': title } }}
        sx={{ m: 0 }}
      />
    }
  />
)
