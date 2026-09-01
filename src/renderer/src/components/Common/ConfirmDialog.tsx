/**
 * A yes/no question, on the app's standard modal shell.
 *
 * It used to be raw MUI - grey paper, default corners - which made the app's
 * plainest dialog the one that looked least like the rest of it.
 */
import React from 'react'
import { Button, Typography } from '@mui/material'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'

import AppDialog, { DANGER_ACCENT } from './AppDialog'

const ConfirmDialog: React.FC<{
  open: boolean
  title: string
  message?: string
  onClose: (ok: boolean) => void
}> = ({ open, title, message, onClose }) => (
  <AppDialog
    open={open}
    onClose={() => onClose(false)}
    maxWidth="xs"
    title={title}
    icon={<WarningAmberRoundedIcon fontSize="small" />}
    // Confirmations in this app are destructive - the affirmative button is
    // error-coloured - so the surface says so before the buttons do.
    accent={DANGER_ACCENT}
    actions={
      <>
        <Button onClick={() => onClose(false)} sx={{ textTransform: 'none' }}>
          取消
        </Button>
        <Button
          variant="contained"
          color="error"
          disableElevation
          onClick={() => onClose(true)}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
        >
          確定
        </Button>
      </>
    }
  >
    <Typography variant="body2" color="text.secondary">
      {message}
    </Typography>
  </AppDialog>
)

export default ConfirmDialog
